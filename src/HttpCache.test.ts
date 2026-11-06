import { describe, expect, test } from 'bun:test'
import { Option } from 'effect'
import { Headers } from 'effect/http'
import * as HttpCache from './HttpCache.ts'

const HOUR = 60 * 60 * 1000
const date = (ms: number) => new Date(ms).toUTCString()
const T0 = Date.parse('2026-01-01T00:00:00Z')

const entry = (headers: Record<string, string>, times = { requestTime: T0, responseTime: T0 }) =>
  HttpCache.fromResponse({
    url: 'https://x.dev/a',
    responseUrl: 'https://x.dev/a',
    headers: Headers.fromInput(headers),
    body: 'body',
    ...times,
  })

describe('parseCacheControl', () => {
  test('parses directives case-insensitively', () => {
    const cc = HttpCache.parseCacheControl('Public, MAX-AGE="60", must-revalidate')
    expect(cc.maxAge).toEqual(Option.some(60))
    expect(cc.mustRevalidate).toBe(true)
    expect(cc.noStore).toBe(false)
  })

  test('ignores invalid max-age and handles missing header', () => {
    expect(HttpCache.parseCacheControl('max-age=abc').maxAge).toEqual(Option.none())
    expect(HttpCache.parseCacheControl(null).noCache).toBe(false)
  })
})

describe('freshness', () => {
  test('max-age wins over Expires', () => {
    const e = entry({ 'cache-control': 'max-age=60', expires: date(T0 + HOUR), date: date(T0) })
    expect(HttpCache.freshnessLifetime(e)).toBe(60_000)
    expect(HttpCache.isFresh(e, T0 + 59_000)).toBe(true)
    expect(HttpCache.isFresh(e, T0 + 61_000)).toBe(false)
  })

  test('Expires is relative to Date', () => {
    const e = entry({ expires: date(T0 + HOUR), date: date(T0) })
    expect(HttpCache.freshnessLifetime(e)).toBe(HOUR)
  })

  test('invalid Expires means expired', () => {
    expect(
      HttpCache.freshnessLifetime(entry({ expires: '0', 'last-modified': date(T0 - 100 * HOUR) })),
    ).toBe(0)
  })

  test('heuristic freshness is 10% of time since Last-Modified, capped at a day', () => {
    expect(
      HttpCache.freshnessLifetime(entry({ date: date(T0), 'last-modified': date(T0 - 10 * HOUR) })),
    ).toBe(HOUR)
    expect(
      HttpCache.freshnessLifetime(
        entry({ date: date(T0), 'last-modified': date(T0 - 1000 * HOUR) }),
      ),
    ).toBe(24 * HOUR)
  })

  test('no explicit freshness and no Last-Modified means stale', () => {
    expect(HttpCache.isFresh(entry({ etag: '"x"' }), T0)).toBe(false)
  })

  test('no-cache is never fresh', () => {
    expect(HttpCache.isFresh(entry({ 'cache-control': 'no-cache, max-age=600' }), T0)).toBe(false)
  })

  test('age counts the Age header and response delay', () => {
    const e = entry({ age: '30', date: date(T0) }, { requestTime: T0, responseTime: T0 + 2_000 })
    expect(HttpCache.currentAge(e, T0 + 12_000)).toBe(30_000 + 2_000 + 10_000)
  })
})

describe('storing and revalidating', () => {
  test('only 200 without no-store is storable', () => {
    expect(HttpCache.isStorable(200, Headers.fromInput({}))).toBe(true)
    expect(HttpCache.isStorable(200, Headers.fromInput({ 'cache-control': 'no-store' }))).toBe(
      false,
    )
    expect(HttpCache.isStorable(206, Headers.fromInput({}))).toBe(false)
  })

  test('conditional headers use stored validators', () => {
    expect(
      HttpCache.conditionalHeaders(entry({ etag: '"v1"', 'last-modified': date(T0) })),
    ).toEqual({
      'if-none-match': '"v1"',
      'if-modified-since': date(T0),
    })
    expect(HttpCache.conditionalHeaders(entry({}))).toEqual({})
  })

  test('freshen keeps the body, merges headers and drops the old Age', () => {
    const old = entry({ etag: '"v1"', 'cache-control': 'max-age=0', age: '100' })
    const fresh = HttpCache.freshen(old, {
      headers: Headers.fromInput({ 'cache-control': 'max-age=60' }),
      requestTime: T0 + HOUR,
      responseTime: T0 + HOUR,
    })
    expect(fresh.body).toBe('body')
    expect(fresh.etag).toBe('"v1"')
    expect(fresh.cacheControl).toBe('max-age=60')
    expect(fresh.age).toBeNull()
    expect(HttpCache.isFresh(fresh, T0 + HOUR + 1_000)).toBe(true)
  })

  test('must-revalidate and no-cache forbid serving stale', () => {
    expect(HttpCache.canServeStale(entry({}))).toBe(true)
    expect(HttpCache.canServeStale(entry({ 'cache-control': 'must-revalidate' }))).toBe(false)
    expect(HttpCache.canServeStale(entry({ 'cache-control': 'no-cache' }))).toBe(false)
  })
})
