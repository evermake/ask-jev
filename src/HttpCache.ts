/**
 * HTTP caching semantics (RFC 9111) for a private cache: what may be stored, whether a stored
 * response is fresh, how to revalidate it, and when a stale response may still be served.
 *
 * Everything here is pure. Times are Unix epoch milliseconds.
 */
import { DateTime, Option, Schema } from 'effect'
import type { Headers } from 'effect/http'

/** A stored `200 OK` response: the body plus the headers caching depends on. */
export class CachedResponse extends Schema.Class<CachedResponse>('@docs/HttpCache/CachedResponse')({
  /** The requested URL, which is the cache key. */
  url: Schema.String,
  /** Where the response came from after redirects; `null` in entries stored before this was tracked. */
  responseUrl: Schema.NullOr(Schema.String),
  body: Schema.String,
  contentType: Schema.NullOr(Schema.String),
  etag: Schema.NullOr(Schema.String),
  lastModified: Schema.NullOr(Schema.String),
  cacheControl: Schema.NullOr(Schema.String),
  expires: Schema.NullOr(Schema.String),
  date: Schema.NullOr(Schema.String),
  age: Schema.NullOr(Schema.String),
  /** When the request that produced (or last revalidated) this response was sent. */
  requestTime: Schema.Int,
  /** When that response was received. */
  responseTime: Schema.Int,
}) {}

/** Upper bound for heuristic freshness, as suggested by RFC 9111 §4.2.2. */
const MAX_HEURISTIC_FRESHNESS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

export interface CacheControl {
  readonly noStore: boolean
  readonly noCache: boolean
  readonly mustRevalidate: boolean
  /** `max-age` in seconds. */
  readonly maxAge: Option.Option<number>
}

/** Parses a `Cache-Control` header. Unknown directives are ignored. */
export const parseCacheControl = (value: string | null): CacheControl => {
  const directives = new Map<string, string | undefined>()
  for (const part of (value ?? '').split(',')) {
    const [rawName = '', ...rest] = part.split('=')
    const name = rawName.trim().toLowerCase()
    if (name === '' || directives.has(name)) continue
    const raw = rest.length > 0 ? rest.join('=').trim() : undefined
    directives.set(name, raw?.replace(/^"(.*)"$/, '$1'))
  }
  const maxAge = directives.get('max-age')
  return {
    noStore: directives.has('no-store'),
    noCache: directives.has('no-cache'),
    mustRevalidate: directives.has('must-revalidate'),
    maxAge:
      maxAge !== undefined && /^\d+$/.test(maxAge) ? Option.some(Number(maxAge)) : Option.none(),
  }
}

/** Parses an HTTP date header into epoch millis. */
export const parseHttpDate = (value: string | null): Option.Option<number> =>
  value === null ? Option.none() : Option.map(DateTime.make(value), DateTime.toEpochMillis)

// ---------------------------------------------------------------------------
// Storing
// ---------------------------------------------------------------------------

/** Whether a response may be stored at all (RFC 9111 §3). */
export const isStorable = (status: number, headers: Headers.Headers): boolean =>
  status === 200 && !parseCacheControl(headers['cache-control'] ?? null).noStore

const headerFields = (headers: Headers.Headers) => ({
  etag: headers['etag'] ?? null,
  lastModified: headers['last-modified'] ?? null,
  cacheControl: headers['cache-control'] ?? null,
  expires: headers['expires'] ?? null,
  date: headers['date'] ?? null,
  age: headers['age'] ?? null,
})

export const fromResponse = (options: {
  readonly url: string
  readonly responseUrl: string
  readonly headers: Headers.Headers
  readonly body: string
  readonly requestTime: number
  readonly responseTime: number
}): CachedResponse =>
  new CachedResponse({
    url: options.url,
    responseUrl: options.responseUrl,
    body: options.body,
    contentType: options.headers['content-type'] ?? null,
    ...headerFields(options.headers),
    requestTime: options.requestTime,
    responseTime: options.responseTime,
  })

/**
 * Updates a stored response with the headers of a `304 Not Modified` (RFC 9111 §4.3.4). Headers
 * missing from the 304 keep their stored values.
 */
export const freshen = (
  entry: CachedResponse,
  options: {
    readonly headers: Headers.Headers
    readonly requestTime: number
    readonly responseTime: number
  },
): CachedResponse => {
  const updated = headerFields(options.headers)
  return new CachedResponse({
    ...entry,
    etag: updated.etag ?? entry.etag,
    lastModified: updated.lastModified ?? entry.lastModified,
    cacheControl: updated.cacheControl ?? entry.cacheControl,
    expires: updated.expires ?? entry.expires,
    date: updated.date ?? entry.date,
    // Age describes the 304 itself, so it must not be carried over.
    age: updated.age,
    requestTime: options.requestTime,
    responseTime: options.responseTime,
  })
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

/** How long the response stays fresh after it was generated (RFC 9111 §4.2.1). */
export const freshnessLifetime = (entry: CachedResponse): number => {
  const cacheControl = parseCacheControl(entry.cacheControl)
  if (Option.isSome(cacheControl.maxAge)) return cacheControl.maxAge.value * 1000

  const date = Option.getOrElse(parseHttpDate(entry.date), () => entry.responseTime)
  if (entry.expires !== null) {
    // An invalid Expires (e.g. "0") means "already expired".
    return Option.match(parseHttpDate(entry.expires), {
      onNone: () => 0,
      onSome: (expires) => Math.max(0, expires - date),
    })
  }

  // Heuristic freshness (RFC 9111 §4.2.2): 10% of the time since last change.
  return Option.match(parseHttpDate(entry.lastModified), {
    onNone: () => 0,
    onSome: (lastModified) =>
      Math.min(MAX_HEURISTIC_FRESHNESS, Math.max(0, (date - lastModified) / 10)),
  })
}

/** How old the response is right now (RFC 9111 §4.2.3). */
export const currentAge = (entry: CachedResponse, now: number): number => {
  const ageValue = entry.age !== null && /^\d+$/.test(entry.age) ? Number(entry.age) * 1000 : 0
  const dateValue = Option.getOrElse(parseHttpDate(entry.date), () => entry.responseTime)
  const apparentAge = Math.max(0, entry.responseTime - dateValue)
  const responseDelay = entry.responseTime - entry.requestTime
  const correctedInitialAge = Math.max(apparentAge, ageValue + responseDelay)
  const residentTime = now - entry.responseTime
  return correctedInitialAge + residentTime
}

/** Whether the stored response can be used without contacting the server. */
export const isFresh = (entry: CachedResponse, now: number): boolean =>
  !parseCacheControl(entry.cacheControl).noCache &&
  freshnessLifetime(entry) > currentAge(entry, now)

/** Whether a stale response may be served when the origin can't be reached (RFC 9111 §4.2.4). */
export const canServeStale = (entry: CachedResponse): boolean => {
  const cacheControl = parseCacheControl(entry.cacheControl)
  return !cacheControl.mustRevalidate && !cacheControl.noCache
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Headers for a conditional request that revalidates the entry (RFC 9110 §13.1). */
export const conditionalHeaders = (entry: CachedResponse): Record<string, string> => {
  const headers: Record<string, string> = {}
  if (entry.etag !== null) headers['if-none-match'] = entry.etag
  if (entry.lastModified !== null) headers['if-modified-since'] = entry.lastModified
  return headers
}
