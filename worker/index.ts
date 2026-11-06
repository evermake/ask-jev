import { DurableObject } from 'cloudflare:workers'
import { Schema } from 'effect'
import { Headers as EffectHeaders } from 'effect/http'
import * as HttpCache from '../src/HttpCache.ts'
import {
  docsUrl,
  isSharedCacheable,
  limitedText,
  markdownAlternatives,
  MAX_API_BYTES,
  MAX_DOC_BYTES,
  PublicError,
} from './security.ts'

interface Env {
  HTTP_CACHE: DurableObjectNamespace<HttpCacheObject>
  REQUEST_LIMITER: RateLimit
  ALLOWED_ORIGINS: string
  DOCS_HOSTS: string
}

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000
const MAX_CACHE_BYTES = 8_000_000
const MAX_CACHE_ENTRIES = 128
const decodeEntry = Schema.decodeUnknownSync(HttpCache.CachedResponse)

/** Only fetched public documentation is persisted. No keys, prompts, or Jev responses. */
export class HttpCacheObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS entries (
      url TEXT PRIMARY KEY, entry TEXT NOT NULL, updated INTEGER NOT NULL, bytes INTEGER NOT NULL
    )`)
  }

  private delete(url: string) {
    this.ctx.storage.sql.exec('DELETE FROM entries WHERE url = ?', url)
  }

  private async store(entry: HttpCache.CachedResponse) {
    const sql = this.ctx.storage.sql
    const json = JSON.stringify(entry)
    sql.exec(
      'INSERT OR REPLACE INTO entries (url, entry, updated, bytes) VALUES (?, ?, ?, ?)',
      entry.url,
      json,
      Date.now(),
      new TextEncoder().encode(json).byteLength,
    )
    const rows = sql
      .exec<{ url: string; bytes: number }>('SELECT url, bytes FROM entries ORDER BY updated DESC')
      .toArray()
    let bytes = 0
    rows.forEach((row, i) => {
      bytes += row.bytes
      if (i >= MAX_CACHE_ENTRIES || bytes > MAX_CACHE_BYTES) this.delete(row.url)
    })
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + RETAIN_MS)
  }

  override async alarm() {
    this.ctx.storage.sql.exec('DELETE FROM entries WHERE updated < ?', Date.now() - RETAIN_MS)
    const [{ count } = { count: 0 }] = this.ctx.storage.sql
      .exec<{ count: number }>('SELECT count(*) AS count FROM entries')
      .toArray()
    if (count > 0) await this.ctx.storage.setAlarm(Date.now() + RETAIN_MS)
  }

  /** Redirects are manual: validate every hop and never forward browser headers or cookies. */
  private async download(input: URL, headers: Record<string, string>) {
    let url = input
    for (let hop = 0; hop < 5; hop++) {
      docsUrl(url.href, this.env.DOCS_HOSTS)
      const response = await fetch(url, {
        headers: { accept: 'text/markdown, text/plain;q=0.9, */*;q=0.1', ...headers },
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (!location) throw new PublicError('Documentation redirect has no location.', 502)
        url = docsUrl(new URL(location, url).href, this.env.DOCS_HOSTS)
        // Validators belong to the original resource, not an arbitrary redirect target.
        headers = {}
        continue
      }
      return { response, url }
    }
    throw new PublicError('Too many documentation redirects.', 502)
  }

  private async load(url: URL): Promise<{ url: string; content: string } | null> {
    const sql = this.ctx.storage.sql
    const row = sql
      .exec<{ entry: string; updated: number }>(
        'SELECT entry, updated FROM entries WHERE url = ?',
        url.href,
      )
      .toArray()[0]
    const cached =
      row && row.updated >= Date.now() - RETAIN_MS ? decodeEntry(JSON.parse(row.entry)) : undefined
    if (row && !cached) this.delete(url.href)
    if (cached && HttpCache.isFresh(cached, Date.now())) {
      return { url: cached.responseUrl ?? cached.url, content: cached.body }
    }
    const requestTime = Date.now()
    let downloaded: Awaited<ReturnType<HttpCacheObject['download']>>
    try {
      downloaded = await this.download(url, cached ? HttpCache.conditionalHeaders(cached) : {})
    } catch (error) {
      // Never turn a security validation failure into a stale-cache success.
      if (!(error instanceof PublicError) && cached && HttpCache.canServeStale(cached)) {
        return { url: cached.responseUrl ?? cached.url, content: cached.body }
      }
      throw error
    }
    const { response, url: actual } = downloaded
    const responseTime = Date.now()
    const headers = EffectHeaders.fromInput(response.headers)
    if (response.status === 304 && cached) {
      await response.body?.cancel()
      const entry = HttpCache.freshen(cached, { headers, requestTime, responseTime })
      const mergedHeaders = new Headers(headers)
      if (entry.cacheControl) mergedHeaders.set('cache-control', entry.cacheControl)
      if (isSharedCacheable(mergedHeaders)) await this.store(entry)
      else this.delete(url.href)
      return { url: entry.responseUrl ?? entry.url, content: entry.body }
    }
    if (response.status >= 500 && cached && HttpCache.canServeStale(cached)) {
      await response.body?.cancel()
      return { url: cached.responseUrl ?? cached.url, content: cached.body }
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new PublicError(`Documentation returned HTTP ${response.status}.`, 502)
    }
    if (
      /^\s*(?:text\/html|application\/xhtml\+xml)\b/i.test(
        response.headers.get('content-type') ?? '',
      )
    ) {
      await response.body?.cancel()
      return null
    }
    const content = await limitedText(response.body, MAX_DOC_BYTES)
    if (/^\s*(?:<!doctype\s+html|<html[\s>])/i.test(content)) return null
    const entry = HttpCache.fromResponse({
      url: url.href,
      responseUrl: actual.href,
      body: content,
      headers,
      requestTime,
      responseTime,
    })
    if (HttpCache.isStorable(response.status, headers) && isSharedCacheable(response.headers))
      await this.store(entry)
    else this.delete(url.href)
    return { url: actual.href, content }
  }

  async getPage(input: string): Promise<{ url: string; content: string }> {
    const url = docsUrl(input, this.env.DOCS_HOSTS)
    const page = await this.load(url)
    if (page) return page
    for (const alternative of markdownAlternatives(url)) {
      try {
        const page = await this.load(alternative)
        if (page) return page
      } catch (error) {
        if (!(error instanceof PublicError) || error.status === 413) throw error
      }
    }
    throw new PublicError('This page is HTML and no Markdown alternative was found.', 502)
  }
}

const Content = Schema.Json
const Question = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('noul'),
    instructions: Content,
    criteria: Schema.optional(
      Schema.Struct({ true: Schema.optional(Content), false: Schema.optional(Content) }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal('choice'),
    instructions: Content,
    criteria: Schema.Record(Schema.String, Content),
  }),
  Schema.Struct({
    type: Schema.Literal('score'),
    instructions: Content,
    criteria: Schema.Array(Content),
  }),
])
const decodeRequest = Schema.decodeUnknownSync(
  Schema.Struct({
    model: Schema.Literals(['jev-latest', 'jev-preview']),
    state: Content,
    questions: Schema.Record(Schema.String, Question),
  }),
)

/** The only destination for a visitor's Authorization header is the fixed Jev endpoint. */
const jev = async (request: Request): Promise<Response> => {
  const authorization = request.headers.get('authorization') ?? ''
  if (!/^Bearer [A-Za-z0-9._~-]{1,512}$/.test(authorization))
    throw new PublicError('Provide your own TypeSafe API key.', 401)
  if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? ''))
    throw new PublicError('Expected application/json.', 415)
  const text = await limitedText(request.body, MAX_API_BYTES)
  let body: ReturnType<typeof decodeRequest>
  try {
    body = decodeRequest(JSON.parse(text))
  } catch {
    throw new PublicError('Invalid System One request.')
  }
  const count = Object.keys(body.questions).length
  if (count < 1 || count > 255) throw new PublicError('Provide 1–255 questions.')
  const upstream = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  })
  if (!upstream.ok) {
    await upstream.body?.cancel()
    // Do not echo upstream error bodies: they may contain request details.
    return Response.json(
      { error: `Jev returned HTTP ${upstream.status}. Check your key, quota, or try again.` },
      { status: upstream.status },
    )
  }
  return new Response(await limitedText(upstream.body, MAX_API_BYTES), {
    headers: { 'content-type': 'application/json' },
  })
}

export default {
  async fetch(request, env): Promise<Response> {
    const origin = request.headers.get('origin') ?? ''
    const allowed = env.ALLOWED_ORIGINS.split(',').map((value) => value.trim())
    if (!allowed.includes(origin)) return new Response('Origin not allowed', { status: 403 })
    const headers = {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'Authorization, Content-Type',
      'access-control-max-age': '600',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      vary: 'Origin',
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    let response: Response
    try {
      const { success } = await env.REQUEST_LIMITER.limit({
        key: request.headers.get('cf-connecting-ip') ?? 'local',
      })
      if (!success) throw new PublicError('Too many requests. Try again in a minute.', 429)
      const url = new URL(request.url)
      if (url.pathname === '/health' && request.method === 'GET') {
        response = Response.json({ ok: true })
      } else if (url.pathname === '/docs' && request.method === 'GET') {
        const target = docsUrl(url.searchParams.get('url') ?? '', env.DOCS_HOSTS)
        const stub = env.HTTP_CACHE.get(env.HTTP_CACHE.idFromName(target.hostname))
        response = Response.json(await stub.getPage(target.href))
      } else if (url.pathname === '/systemone' && request.method === 'POST' && !url.search) {
        response = await jev(request)
      } else {
        throw new PublicError('Not found.', 404)
      }
    } catch (error) {
      response = Response.json(
        {
          error:
            error instanceof PublicError
              ? error.message
              : 'Upstream request failed. Please try again.',
        },
        { status: error instanceof PublicError ? error.status : 502 },
      )
    }
    const result = new Response(response.body, response)
    for (const [key, value] of Object.entries(headers)) result.headers.set(key, value)
    return result
  },
} satisfies ExportedHandler<Env>
