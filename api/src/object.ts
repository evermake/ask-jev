import { DurableObject } from 'cloudflare:workers'
import type { DocsEntry } from '@ask-jev/shared'
import { Docs, Documentation, DocsResolver, Markdown, SystemOne } from 'ask-jev'
import { ByteSize, Effect, Layer, Redacted, Schema } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { cacheStorage } from './cache.ts'
import { MAX_SEARCH_BUDGET, SearchInput, type PageResult } from './contracts.ts'
import { docsSource, docsTarget, docsUrl, limitedText, MAX_API_SIZE, MAX_DOC_SIZE, PublicError } from './security.ts'
import type { Env } from './index.ts'

const decodeSearch = Schema.decodeUnknownSync(SearchInput)

/** The legacy class name/migration is retained to preserve deployed per-host SQLite caches. */
export class HttpCacheObject extends DurableObject<Env> {
  private readonly cache

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.cache = cacheStorage(ctx.storage)
  }

  /** Immutable request-local policy; the shared storage adapter contains no source or visitor state. */
  private documentation(source: DocsEntry) {
    const policy = Layer.succeed(Documentation.DocsPolicy, {
      maxBytes: ByteSize.toNumberUnsafe(MAX_DOC_SIZE),
      validate: (url) => Effect.try({
        try: () => { docsUrl(url.href, source) },
        catch: () => new DocsResolver.DocsResolverError({
          url: url.href, message: 'Documentation URL is not allowed for the selected source.', status: 400,
        }),
      }),
    })
    return Documentation.layer.pipe(
      Layer.provide(Layer.mergeAll(this.cache.layer, policy, Documentation.layerFetch)),
    )
  }

  override async alarm() { await this.cache.alarm() }

  override async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url)
      if (!((url.pathname === '/api/page' && request.method === 'GET') ||
          (url.pathname === '/api/search' && request.method === 'POST'))) throw new PublicError('Not found.', 404)
      const source = docsSource(url.searchParams)
      const target = docsTarget(url.searchParams, source, url.pathname === '/api/search')
      const expected = this.env.HTTP_CACHE.idFromName(new URL(source.indexUrl).hostname)
      if (!this.ctx.id.equals(expected)) throw new PublicError('Documentation source does not match this cache.', 400)
      const documentation = this.documentation(source)
      if (url.pathname === '/api/page' && request.method === 'GET') {
        const page = await Effect.gen(function* () {
          const resolver = yield* DocsResolver.DocsResolver
          return yield* resolver.fetch(target)
        }).pipe(Effect.provide(documentation), (effect) => Effect.runPromise(effect, { signal: request.signal }))
        const seen = new Set<string>()
        const links = Markdown.linkEntries(page.content).flatMap((link) => {
          const destination = URL.parse(link.url, page.url)
          if (!destination || destination.origin !== target.origin) return []
          destination.hash = ''
          try { docsUrl(destination.href, source) } catch { return [] }
          if (seen.has(destination.href)) return []
          seen.add(destination.href)
          return [{ url: destination.href, text: link.text || destination.pathname }]
        })
        return Response.json({ url: page.url.href, content: page.content, links, toc: Markdown.toc(page.content) } satisfies PageResult)
      }
      if (url.pathname !== '/api/search' || request.method !== 'POST') throw new PublicError('Not found.', 404)
      const apiKey = this.env.OPENROUTER_API_KEY?.trim()
      if (!apiKey) throw new PublicError('Demo search is not configured. Please try again later.', 503)
      if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) throw new PublicError('Expected application/json.', 415)
      const text = await limitedText(request.body, ByteSize.toNumberUnsafe(MAX_API_SIZE))
      let input: SearchInput
      try { input = decodeSearch(JSON.parse(text)) }
      catch { throw new PublicError('Invalid search request.') }
      if (!input.query.trim() || input.query.length > 4_000 ||
          (input.budget !== undefined && (!Number.isFinite(input.budget) || input.budget <= 0 || input.budget > MAX_SEARCH_BUDGET))) {
        throw new PublicError(`Use a non-empty question (up to 4000 characters) and an estimated budget greater than $0 and at most $${MAX_SEARCH_BUDGET.toFixed(2)}.`)
      }
      // Only the operator's secret authenticates model calls; caller credentials are ignored.
      // workerd accepts follow/manual, not redirect:error. Explicitly reject all redirects.
      const safeFetch: typeof fetch = async (input, init) => {
        if (String(input) !== SystemOne.OPENROUTER_ENDPOINT) throw new Error('Unexpected Jev endpoint')
        const upstream = await fetch(input, { ...init, redirect: 'manual' })
        if (upstream.status >= 300 && upstream.status < 400) {
          await upstream.body?.cancel()
          throw new Error('Jev redirects are not allowed')
        }
        // Do not retain or expose upstream error bodies, which may echo private data.
        if (!upstream.ok) {
          await upstream.body?.cancel()
          return new Response(null, { status: upstream.status })
        }
        return new Response(await limitedText(upstream.body, ByteSize.toNumberUnsafe(MAX_API_SIZE)), {
          status: upstream.status, headers: { 'content-type': 'application/json' },
        })
      }
      const jev = SystemOne.layerWith(
        Effect.succeed(Redacted.make(apiKey)),
        SystemOne.OPENROUTER_ENDPOINT,
      ).pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, safeFetch)),
      )
      const result = await Effect.gen(function* () {
        const docs = yield* Docs.make(target)
        return yield* docs.search(input.query, {
          budget: input.budget ?? MAX_SEARCH_BUDGET,
          ...(input.model === undefined ? {} : { model: input.model }),
        })
      }).pipe(
        Effect.provide(Layer.merge(documentation, jev)),
        (effect) => Effect.runPromise(effect, { signal: request.signal }),
      )
      return Response.json(result)
    } catch (error) {
      // Effect.runPromise preserves typed failures; no raw causes/requests are serialized.
      return Response.json({ error: error instanceof PublicError || error instanceof DocsResolver.DocsResolverError
        ? error.message : error instanceof SystemOne.SystemOneError
          ? 'The demo model is unavailable. Please try again later.'
          : 'Search or documentation request failed. Please try again.' }, {
        status: error instanceof PublicError ? error.status
          : error instanceof DocsResolver.DocsResolverError ? error.status ?? 502 : 502,
        headers: { 'cache-control': 'no-store' },
      })
    }
  }
}
