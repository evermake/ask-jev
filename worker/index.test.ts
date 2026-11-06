import { afterEach, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'

// Use real SQLite and the actual Worker implementation without making network calls or using keys.
mock.module('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}))
const { HttpCacheObject, default: worker } = await import('./index.ts')
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const origin = 'https://evermake.github.io'
const make = () => {
  const db = new Database(':memory:')
  let alarm: number | null = null
  const ctx = {
    storage: {
      sql: {
        exec: (sql: string, ...args: Array<string | number>) => ({
          toArray: () => db.query(sql).all(...args),
        }),
      },
      getAlarm: async () => alarm,
      setAlarm: async (value: number) => {
        alarm = value
      },
    },
  }
  // Statements execute immediately, just as Durable Object SQL statements do.
  ctx.storage.sql.exec = (sql, ...args) => {
    const rows = db.query(sql).all(...args)
    return { toArray: () => rows }
  }
  const env = {
    ALLOWED_ORIGINS: origin,
    DOCS_HOSTS: 'docs.typesafe.ai',
    REQUEST_LIMITER: { limit: async () => ({ success: true }) },
    HTTP_CACHE: { idFromName: (name: string) => name, get: () => object },
  }
  const object = new HttpCacheObject(ctx as never, env as never)
  const request = (path: string, init: RequestInit = {}) =>
    worker.fetch(
      new Request(`https://worker.example${path}`, {
        ...init,
        headers: { origin, ...Object.fromEntries(new Headers(init.headers)) },
      }),
      env as never,
      {} as never,
    )
  return { db, object, request, env }
}

test('SQLite cache persists public docs, serves fresh entries, and revalidates stale entries', async () => {
  const { object, db } = make()
  let calls = 0
  globalThis.fetch = mock(async (_input, init) => {
    calls++
    expect(new Headers(init?.headers).get('authorization')).toBeNull()
    expect(new Headers(init?.headers).get('cookie')).toBeNull()
    if (calls === 1)
      return new Response('# Public docs', {
        headers: { 'cache-control': 'public, max-age=60', etag: 'v1' },
      })
    expect(new Headers(init?.headers).get('if-none-match')).toBe('v1')
    return new Response(null, { status: 304, headers: { 'cache-control': 'public, max-age=60' } })
  }) as typeof fetch
  const url = 'https://docs.typesafe.ai/llms.txt'
  expect((await object.getPage(url)).content).toBe('# Public docs')
  expect((await object.getPage(url)).content).toBe('# Public docs')
  expect(calls).toBe(1)
  const row = db.query('SELECT entry FROM entries').get() as { entry: string }
  const stale = JSON.parse(row.entry)
  stale.cacheControl = 'max-age=0'
  db.query('UPDATE entries SET entry = ?').run(JSON.stringify(stale))
  expect((await object.getPage(url)).content).toBe('# Public docs')
  expect(calls).toBe(2)
  db.close()
})

test('does not store private documentation or forward credentials', async () => {
  const { object, db } = make()
  globalThis.fetch = mock(
    async () => new Response('not cached', { headers: { 'cache-control': 'private, max-age=60' } }),
  ) as typeof fetch
  await object.getPage('https://docs.typesafe.ai/a.md')
  expect(db.query('SELECT count(*) AS n FROM entries').get()).toEqual({ n: 0 })
  db.close()
})

test('validates redirects before fetching their target', async () => {
  const { object, db } = make()
  const upstream = mock(
    async () =>
      new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }),
  )
  globalThis.fetch = upstream as typeof fetch
  await expect(object.getPage('https://docs.typesafe.ai/a.md')).rejects.toThrow(
    'configured DOCS_HOSTS',
  )
  expect(upstream).toHaveBeenCalledTimes(1)
  db.close()
})

test('falls back from HTML to Markdown', async () => {
  const { object, db } = make()
  globalThis.fetch = mock(async (input) =>
    String(input).endsWith('.md')
      ? new Response('# Markdown', { headers: { 'cache-control': 'public, max-age=60' } })
      : new Response('<html>not rendered</html>', { headers: { 'content-type': 'text/html' } }),
  ) as typeof fetch
  expect(await object.getPage('https://docs.typesafe.ai/guide')).toEqual({
    url: 'https://docs.typesafe.ai/guide.md',
    content: '# Markdown',
  })
  expect(db.query('SELECT count(*) AS n FROM entries').get()).toEqual({ n: 1 })
  db.close()
})

test('rejects foreign origins, enforces rate limits, and sets non-cacheable CORS responses', async () => {
  const { request, env, db } = make()
  const denied = await worker.fetch(
    new Request('https://worker.example/health'),
    env as never,
    {} as never,
  )
  expect(denied.status).toBe(403)
  expect(denied.headers.get('access-control-allow-origin')).toBeNull()
  const preflight = await request('/systemone', { method: 'OPTIONS' })
  expect(preflight.status).toBe(204)
  expect(preflight.headers.get('access-control-allow-origin')).toBe(origin)
  expect(preflight.headers.get('cache-control')).toBe('no-store')
  env.REQUEST_LIMITER.limit = async () => ({ success: false })
  expect((await request('/docs?url=https://docs.typesafe.ai/llms.txt')).status).toBe(429)
  db.close()
})

test('Jev proxy forwards a visitor key only to the fixed endpoint and never stores it', async () => {
  const { request, db } = make()
  const visitorKey = 'test-key-not-a-real-credential'
  const upstream = mock(async (input, init) => {
    expect(String(input)).toBe('https://api.typesafe.ai/v1/systemone')
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${visitorKey}`)
    expect(new Headers(init?.headers).get('cookie')).toBeNull()
    expect(init?.redirect).toBe('error')
    return Response.json({
      model: 'jev-test',
      answers: {},
      usage: { input_tokens: 0, output_tokens: 0 },
    })
  })
  globalThis.fetch = upstream as typeof fetch
  const response = await request('/systemone', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${visitorKey}`,
      'content-type': 'application/json',
      cookie: 'private=not-forwarded',
    },
    body: JSON.stringify({
      model: 'jev-latest',
      state: 'test prompt',
      questions: { q: { type: 'noul', instructions: 'test?' } },
      endpoint: 'https://evil.example',
    }),
  })
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(JSON.stringify(db.query('SELECT * FROM entries').all())).not.toContain(visitorKey)
  expect(db.query('SELECT count(*) AS n FROM entries').get()).toEqual({ n: 0 })
  expect(upstream).toHaveBeenCalledTimes(1)
  db.close()
})

test('rejects missing keys, unsupported models and malformed bodies without calling Jev', async () => {
  const { request, db } = make()
  const upstream = mock(async () => {
    throw new Error('Must not be called')
  })
  globalThis.fetch = upstream as typeof fetch
  expect((await request('/systemone', { method: 'POST' })).status).toBe(401)
  expect(
    (
      await request('/systemone', {
        method: 'POST',
        headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
        body: '{',
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await request('/systemone', {
        method: 'POST',
        headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'unsupported', state: {}, questions: {} }),
      })
    ).status,
  ).toBe(400)
  expect(upstream).not.toHaveBeenCalled()
  db.close()
})

test('does not echo upstream errors or credentials to the browser', async () => {
  const { request, db } = make()
  globalThis.fetch = mock(
    async () => new Response('sensitive upstream details', { status: 401 }),
  ) as typeof fetch
  const response = await request('/systemone', {
    method: 'POST',
    headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'jev-latest',
      state: {},
      questions: { q: { type: 'noul', instructions: '?' } },
    }),
  })
  expect(response.status).toBe(401)
  expect(await response.text()).not.toContain('sensitive upstream details')
  db.close()
})
