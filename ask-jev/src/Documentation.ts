import { Clock, Context, Duration, Effect, Layer, Result } from 'effect'
import { Headers as EffectHeaders } from 'effect/http'
import { DocsResolver, DocsResolverError, type Page } from './DocsResolver.ts'
import * as HttpCache from './HttpCache.ts'

/** Persist public documentation only. Implementations own retention, eviction and serialization. */
export class CacheStorage extends Context.Service<CacheStorage, {
  readonly get: (url: string) => Effect.Effect<HttpCache.CachedResponse | undefined, DocsResolverError>
  readonly set: (entry: HttpCache.CachedResponse) => Effect.Effect<void, DocsResolverError>
  readonly remove: (url: string) => Effect.Effect<void, DocsResolverError>
}>()('ask-jev/CacheStorage') {}

/** Must return redirects un-followed. Never attach caller credentials or cookies. */
export class DocsTransport extends Context.Service<DocsTransport, {
  readonly get: (url: URL, headers: Record<string, string>) => Effect.Effect<Response, DocsResolverError>
}>()('ask-jev/DocsTransport') {}

/** Validation runs before cache access and before every redirect/fallback. */
export class DocsPolicy extends Context.Service<DocsPolicy, {
  readonly validate: (url: URL) => Effect.Effect<void, DocsResolverError>
  readonly maxBytes: number
}>()('ask-jev/DocsPolicy') {}

const REQUEST_TIMEOUT = Duration.seconds(10)

export const layerFetch = Layer.succeed(DocsTransport, {
  get: (url, headers) => Effect.tryPromise({
    try: (signal) => fetch(url, {
      headers: { accept: 'text/markdown, text/plain;q=0.9, */*;q=0.1', ...headers },
      redirect: 'manual',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.any([signal, AbortSignal.timeout(Duration.toMillis(REQUEST_TIMEOUT))]),
    }),
    catch: () => new DocsResolverError({ url: url.href, message: 'Documentation request failed.', status: 502 }),
  }),
})

export const isSharedCacheable = (headers: Headers): boolean =>
  !headers.has('set-cookie') &&
  !/(?:^|,)\s*(?:private|no-store)\b/i.test(headers.get('cache-control') ?? '') &&
  !(headers.get('vary') ?? '')
    .split(',')
    .some((value) => ['*', 'cookie', 'authorization'].includes(value.trim().toLowerCase()))

export const markdownAlternatives = (url: URL): Array<URL> => {
  const path = url.pathname
  const paths = path.endsWith('/')
    ? [`${path}index.md`, ...(path === '/' ? [] : [`${path.slice(0, -1)}.md`])]
    : !path.slice(path.lastIndexOf('/') + 1).includes('.')
      ? [`${path}.md`, `${path}/index.md`]
      : /\.html?$/i.test(path) ? [path.replace(/\.html?$/i, '.md')] : []
  return paths.map((path) => new URL(`${url.origin}${path}`))
}

/** Enforces UTF-8 byte limits while streaming, including bodies without Content-Length. */
export const limitedText = async (body: ReadableStream<Uint8Array> | null, limit: number): Promise<string> => {
  if (!body) return ''
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return text + decoder.decode()
      size += value.byteLength
      if (size > limit) throw new Error('Body is too large.')
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** RFC 9111 caching, conditional revalidation, safe stale fallback and Markdown discovery. */
export const make = Effect.gen(function* () {
  const storage = yield* CacheStorage
  const transport = yield* DocsTransport
  const policy = yield* DocsPolicy
  const fail = (url: URL, message: string, status = 502) =>
    Effect.fail(new DocsResolverError({ url: url.href, message, status }))
  const cancel = (response: Response) => Effect.promise(async () => { await response.body?.cancel() })
  const pageOf = (entry: HttpCache.CachedResponse): Page => ({
    url: new URL(entry.responseUrl ?? entry.url), content: entry.body,
  })
  const download = Effect.fn('Documentation.download')(function* (input: URL, validators: Record<string, string>) {
    let url = input
    let headers = validators
    for (let hop = 0; hop < 5; hop++) {
      yield* policy.validate(url)
      // Only transport failures permit stale fallback; policy failures never do.
      const result = yield* Effect.result(transport.get(url, headers))
      if (Result.isFailure(result)) return { result, url }
      const response = result.success
      if (![301, 302, 303, 307, 308].includes(response.status)) return { result, url }
      const location = response.headers.get('location')
      yield* cancel(response)
      if (!location) return yield* fail(url, 'Documentation redirect has no location.')
      const next = URL.parse(location, url)
      if (!next) return yield* fail(url, 'Invalid documentation redirect.')
      url = next
      headers = {}
    }
    return yield* fail(url, 'Too many documentation redirects.')
  })
  const load = Effect.fn('Documentation.load')(function* (url: URL) {
    yield* policy.validate(url)
    const cached = yield* storage.get(url.href)
    if (cached?.responseUrl) yield* policy.validate(new URL(cached.responseUrl))
    if (cached && HttpCache.isFresh(cached, yield* Clock.currentTimeMillis)) return pageOf(cached)
    const requestTime = yield* Clock.currentTimeMillis
    const { result, url: actual } = yield* download(url, cached ? HttpCache.conditionalHeaders(cached) : {})
    if (Result.isFailure(result)) {
      if (cached && HttpCache.canServeStale(cached)) return pageOf(cached)
      return yield* Effect.fail(result.failure)
    }
    const response = result.success
    const responseTime = yield* Clock.currentTimeMillis
    const headers = EffectHeaders.fromInput(response.headers)
    if (response.status === 304 && cached) {
      yield* cancel(response)
      const entry = HttpCache.freshen(cached, { headers, requestTime, responseTime })
      const merged = new Headers(response.headers)
      if (entry.cacheControl) merged.set('cache-control', entry.cacheControl)
      if (isSharedCacheable(merged)) yield* storage.set(entry)
      else yield* storage.remove(url.href)
      return pageOf(entry)
    }
    if (response.status >= 500 && cached && HttpCache.canServeStale(cached)) {
      yield* cancel(response)
      return pageOf(cached)
    }
    if (!response.ok) {
      yield* cancel(response)
      return yield* fail(url, `Documentation returned HTTP ${response.status}.`)
    }
    if (/^\s*(?:text\/html|application\/xhtml\+xml)\b/i.test(response.headers.get('content-type') ?? '')) {
      yield* cancel(response)
      return null
    }
    const content = yield* Effect.tryPromise({
      try: () => limitedText(response.body, policy.maxBytes),
      catch: () => new DocsResolverError({ url: url.href, message: 'Documentation body failed or is too large.', status: 413 }),
    })
    if (/^\s*(?:<!doctype\s+html|<html[\s>])/i.test(content)) return null
    const entry = HttpCache.fromResponse({ url: url.href, responseUrl: actual.href, body: content, headers, requestTime, responseTime })
    if (HttpCache.isStorable(response.status, headers) && isSharedCacheable(response.headers)) yield* storage.set(entry)
    else yield* storage.remove(url.href)
    return { url: actual, content }
  })
  return DocsResolver.of({
    fetch: Effect.fn('Documentation.fetch')(function* (url: URL) {
      const page = yield* load(url)
      if (page) return page
      for (const alternative of markdownAlternatives(url)) {
        const result = yield* Effect.result(load(alternative))
        if (Result.isSuccess(result)) {
          if (result.success) return result.success
        } else if (result.failure.status !== 502) {
          return yield* Effect.fail(result.failure)
        }
      }
      return yield* fail(url, 'This page is HTML and no Markdown alternative was found.')
    }),
  })
})

export const layer = Layer.effect(DocsResolver, make)
