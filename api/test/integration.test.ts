import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Miniflare, Response, type Request as MfRequest } from 'miniflare'
import type { PageResult, SearchResult } from '../src/contracts.ts'
import { DOCS } from '@ask-jev/shared'

let script: string
before(async () => {
  const bundle = await build({
    stdin: {
      // Instrument namespace admission without replacing the real DO/cache implementation.
      contents: `import api from './src/index.ts';
        export { HttpCacheObject } from './src/index.ts';
        export default { fetch(request, env) {
          if (request.headers.has('x-test-forbid-routing')) {
            env = { ...env, HTTP_CACHE: { idFromName() { throw new Error('Unexpected DO routing'); } } };
          }
          if (request.headers.has('x-test-cancel-on-model')) {
            const controller = new AbortController();
            const response = api.fetch(new Request(request, { signal: controller.signal }), env);
            void fetch('https://cancellation.test/ready').then(() => controller.abort());
            return response;
          }
          return api.fetch(request, env);
        } };`,
      resolveDir: process.cwd(), sourcefile: 'integration-worker.ts',
    },
    bundle: true, write: false, format: 'esm',
    platform: 'neutral', mainFields: ['module', 'main'], conditions: ['workerd', 'worker'],
    target: 'es2023', external: ['cloudflare:workers'],
  })
  script = bundle.outputFiles[0]!.text
})

const origin = 'https://playground.example'
async function setup(
  upstream: (request: MfRequest) => Promise<Response>,
  limit = 120,
  options: { apiKey?: string; searchLimit?: number; demoLimit?: number } = {},
) {
  const mf = new Miniflare({ ...convertV4MiniflareOptions({
    name: 'api', modules: true, script, compatibilityDate: '2026-11-06',
    compatibilityFlags: ['enable_request_signal'],
    durableObjects: { HTTP_CACHE: { className: 'HttpCacheObject', useSQLite: true } },
    bindings: { ALLOWED_ORIGINS: origin, OPENROUTER_API_KEY: options.apiKey ?? 'synthetic-operator-key' },
    ratelimits: {
      REQUEST_LIMITER: { namespace_id: '538561', simple: { limit, period: 60 } },
      SEARCH_LIMITER: { namespace_id: '538562', simple: { limit: options.searchLimit ?? 1000, period: 60 } },
      DEMO_LIMITER: { namespace_id: '538563', simple: { limit: options.demoLimit ?? 1000, period: 60 } },
    },
    outboundService: upstream,
  }), unsafeInspectDurableObjects: true })
  try { await mf.ready } catch (error) { await mf.dispose(); throw error }
  const request = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => mf.dispatchFetch(`https://api.example${path}`, {
    ...init,
    headers: { origin, ...Object.fromEntries(new Headers(init.headers)) },
  })
  const search = (body: unknown = { query: 'What is documented?' }, key = '', docs = 'typesafe', url?: string, headers: Record<string, string> = {}) => request(`/api/search?${new URLSearchParams({ docs, ...(url === undefined ? {} : { url }) })}`, {
    method: 'POST', headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const storage = (name = 'docs.typesafe.ai') => mf.unsafeGetDurableObjectStorage('api', 'HttpCacheObject', { name })
  return { mf, request, search, storage }
}

const docsPath = '/api/page?docs=typesafe'

function assertSearchDuration(result: SearchResult) {
  const { duration } = result
  assert.deepEqual(Object.keys(duration).sort(), ['jevMs', 'restMs', 'totalMs'])
  for (const value of Object.values(duration)) {
    assert.ok(Number.isFinite(value) && value >= 0, 'Durations are finite, nonnegative milliseconds')
  }
  assert.ok(duration.jevMs <= duration.totalMs)
  assert.ok(Math.abs(duration.totalMs - duration.jevMs - duration.restMs) < 0.000001)
}

test('real DO SQLite caches, survives eviction, revalidates and never forwards browser credentials', async (t) => {
  let calls = 0
  const { mf, request, storage } = await setup(async (request) => {
    calls++
    assert.equal(request.headers.get('authorization'), null)
    assert.equal(request.headers.get('cookie'), null)
    if (calls === 1) return new Response('# Public docs\n\n[Guide](/guide.md)', {
      headers: { 'cache-control': 'public, max-age=60', etag: 'v1' },
    })
    assert.equal(request.headers.get('if-none-match'), 'v1')
    return new Response(null, { status: 304, headers: { 'cache-control': 'public, max-age=60' } })
  })
  t.after(() => mf.dispose())
  const page = await (await request(docsPath, { headers: { authorization: 'Bearer ignored', cookie: 'private=secret' } })).json() as PageResult
  assert.equal(page.content, '# Public docs\n\n[Guide](/guide.md)')
  assert.deepEqual(page.links, [{ url: 'https://docs.typesafe.ai/guide.md', text: '[Guide](/guide.md)' }])
  await mf.unsafeEvictDurableObject('api', 'HttpCacheObject', { name: 'docs.typesafe.ai' })
  assert.equal((await request(docsPath)).status, 200)
  assert.equal(calls, 1)
  const db = await storage()
  const [row] = await db.exec<{ entry: string }>('SELECT entry FROM entries')
  const entry = JSON.parse(row!.entry)
  entry.cacheControl = 'max-age=0'
  await db.exec('UPDATE entries SET entry = ?', JSON.stringify(entry))
  assert.equal((await request(docsPath)).status, 200)
  assert.equal(calls, 2)
})

test('does not store private docs; falls back from HTML to Markdown', async (t) => {
  const { mf, request, storage } = await setup(async (request) => new URL(request.url).pathname.endsWith('.md')
    ? new Response('# Markdown', { headers: { 'cache-control': 'private, max-age=60' } })
    : new Response('<html>not rendered</html>', { headers: { 'content-type': 'text/html' } }))
  t.after(() => mf.dispose())
  const response = await request('/api/page?docs=typesafe&url=https://docs.typesafe.ai/guide')
  assert.equal(response.status, 200)
  const page = await response.json() as PageResult
  assert.equal(page.url, 'https://docs.typesafe.ai/guide.md')
  assert.equal(page.content, '# Markdown')
  assert.deepEqual(await (await storage()).exec('SELECT count(*) AS n FROM entries'), [{ n: 0 }])
})

test('a forbidden redirect fails even when a stale cache entry exists', async (t) => {
  let calls = 0
  const { mf, request } = await setup(async () => ++calls === 1
    ? new Response('old docs', { headers: { 'cache-control': 'max-age=0' } })
    : new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }))
  t.after(() => mf.dispose())
  assert.equal((await request(docsPath)).status, 200)
  assert.equal((await request(docsPath)).status, 400)
  assert.equal(calls, 2)
})

test('public search uses only the operator OpenRouter secret, accepts >255 questions, and persists only docs', async (t) => {
  const keys: string[] = []
  const counts: number[] = []
  const content = '# Public docs\n\n' + Array.from({ length: 150 }, (_, i) => `- [Guide ${i}](/guide-${i}.md): guide`).join('\n')
  let docsCalls = 0
  const { mf, search, storage } = await setup(async (request) => {
    if (new URL(request.url).hostname === 'docs.typesafe.ai') {
      docsCalls++
      assert.equal(request.headers.get('authorization'), null)
      return new Response(content, { headers: { 'cache-control': 'public, max-age=60' } })
    }
    assert.equal(request.url, 'https://openrouter.ai/api/v1/systemone')
    assert.equal(request.headers.get('cookie'), null)
    assert.equal(request.headers.get('traceparent'), null)
    keys.push(request.headers.get('authorization')!)
    const body = await request.json() as { questions: Record<string, unknown> }
    counts.push(Object.keys(body.questions).length)
    await delay(20)
    return Response.json({ model: 'typesafe/jev-test', answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: 0.95 }])), usage: { input_tokens: 100, output_tokens: 0, cost: 0.0000123 } })
  })
  t.after(() => mf.dispose())
  const response = await search({ query: 'synthetic-private-question', budget: 0.02 })
  assert.equal(response.status, 200, await response.clone().text())
  const result = await response.json() as SearchResult
  assert.equal(result.stopped, 'answered')
  assert.ok(result.passages.length > 0)
  assert.equal(result.usage.requests, 2)
  assert.equal(result.usage.cost, 0.0000246)
  assertSearchDuration(result)
  assert.ok(result.duration.jevMs > 0, 'Delayed upstream evaluations contribute elapsed time')
  assert.equal(counts[0], 302)
  assert.deepEqual(keys, ['Bearer synthetic-operator-key', 'Bearer synthetic-operator-key'])
  // Caller credentials never override the secret; a later visitor shares only public docs.
  const nextResponse = await search({ query: 'another-question' }, 'another-synthetic-key', 'typesafe', undefined, { cookie: 'private=synthetic' })
  assert.equal(nextResponse.status, 200)
  assertSearchDuration(await nextResponse.json() as SearchResult)
  assert.deepEqual(keys.slice(2), ['Bearer synthetic-operator-key', 'Bearer synthetic-operator-key'])
  assert.equal(docsCalls, 1)
  const persisted = JSON.stringify(await (await storage()).exec('SELECT * FROM entries'))
  for (const privateValue of ['synthetic-operator-key', 'another-synthetic-key', 'synthetic-private-question', 'another-question', 'jev-test']) assert.ok(!persisted.includes(privateValue))
  assert.ok(!JSON.stringify(result).includes('synthetic-operator-key'))
})

test('search duration is entirely rest when the budget prevents model evaluations', async (t) => {
  let jevCalls = 0
  const { mf, search } = await setup(async (request) => {
    if (new URL(request.url).hostname !== 'openrouter.ai') {
      return new Response('# Public docs\n\nSynthetic documentation.')
    }
    jevCalls++
    return new Response('Unexpected model request', { status: 500 })
  })
  t.after(() => mf.dispose())
  const response = await search({ query: 'Synthetic question', budget: 0.000001 })
  assert.equal(response.status, 200, await response.clone().text())
  const result = await response.json() as SearchResult
  assertSearchDuration(result)
  assert.equal(result.stopped, 'budget')
  assert.equal(result.usage.requests, 0)
  assert.equal(result.duration.jevMs, 0)
  assert.equal(result.duration.restMs, result.duration.totalMs)
  assert.equal(jevCalls, 0)
})

test('omitting a budget still applies the demo estimate and forwards only allowed model choices', async (t) => {
  let jevCalls = 0
  let expectedModel = 'jev-latest'
  const { mf, search } = await setup(async (request) => {
    if (new URL(request.url).hostname === 'docs.typesafe.ai') {
      return new Response('# Docs\n\n[More](/more.md)')
    }
    jevCalls++
    assert.equal(request.url, 'https://openrouter.ai/api/v1/systemone')
    assert.equal(request.headers.get('authorization'), 'Bearer synthetic-operator-key')
    const body = await request.json() as { model: string; questions: Record<string, unknown> }
    assert.equal(body.model, expectedModel)
    return Response.json({
      model: `typesafe/${expectedModel}`,
      answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: 0.1 }])),
      usage: { input_tokens: 100, output_tokens: 0, cost: 0.03 },
    })
  })
  t.after(() => mf.dispose())
  for (const model of [undefined, 'jev-preview']) {
    expectedModel = model ?? 'jev-latest'
    const response = await search({ query: 'Synthetic question', ...(model ? { model } : {}) })
    assert.equal(response.status, 200)
    const result = await response.json() as SearchResult
    assert.equal(result.stopped, 'budget')
    assert.equal(result.usage.requests, 1, 'No subsequent evaluations once reported spending exceeds the default demo estimate')
    assert.equal(result.usage.cost, 0.03)
    assert.equal(result.model, `typesafe/${expectedModel}`)
  }
  assert.equal(jevCalls, 2)
})

test('validates public search input before spending; hides OpenRouter error bodies and redirects', async (t) => {
  let jevCalls = 0
  let redirect = false
  const { mf, request, search } = await setup(async (request) => {
    if (new URL(request.url).hostname === 'docs.typesafe.ai') return new Response('Public docs')
    jevCalls++
    return redirect ? new Response(null, { status: 302, headers: { location: 'https://evil.example/collect' } })
      : new Response('sensitive-upstream-details', { status: 401 })
  })
  t.after(() => mf.dispose())
  assert.equal((await request('/api/search?docs=typesafe', { method: 'POST' })).status, 415)
  for (const body of [{ query: '' }, { query: 'x'.repeat(4001) }, { query: 'x', budget: 0 }, { query: 'x', budget: -1 }, { query: 'x', budget: 0.021 }, { query: 'x', budget: 2 }, { query: 'x', model: 'unsupported' }]) {
    assert.equal((await search(body)).status, 400)
  }
  assert.equal(jevCalls, 0)
  const response = await search()
  assert.equal(response.status, 502)
  assert.deepEqual(Object.keys(await response.clone().json() as object), ['error'])
  assert.ok(!(await response.text()).includes('sensitive-upstream-details'))
  redirect = true
  assert.equal((await search()).status, 502)
  assert.equal(jevCalls, 2) // No speculative duplicates, retries or followed redirects.
})

test('missing operator secret disables search before any fetch, but browsing still works', async (t) => {
  let calls = 0
  const { mf, search, request } = await setup(async () => {
    calls++
    return new Response('Public documentation')
  }, 120, { apiKey: '' })
  t.after(() => mf.dispose())
  const response = await search()
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.match((await response.json() as { error: string }).error, /not configured/)
  assert.equal(calls, 0)
  assert.equal((await search(undefined, 'caller-cannot-enable-demo')).status, 503)
  assert.equal(calls, 0)
  assert.equal((await request(docsPath)).status, 200)
  assert.equal(calls, 1)
})

test('request signal cancellation interrupts the DO search before any subsequent paid evaluation', { timeout: 15_000 }, async (t) => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let jevCalls = 0
  const { mf, search } = await setup(async (request) => {
    if (request.url === 'https://cancellation.test/ready') {
      await started.promise
      return new Response(null)
    }
    if (new URL(request.url).hostname === 'docs.typesafe.ai') {
      return new Response('# Docs\n\nSynthetic passage.', { headers: { 'cache-control': 'max-age=60' } })
    }
    assert.equal(request.url, 'https://openrouter.ai/api/v1/systemone')
    jevCalls++
    const body = await request.json() as { questions: Record<string, unknown> }
    if (jevCalls === 1) {
      started.resolve()
      await release.promise
    }
    return Response.json({
      model: 'typesafe/jev-test',
      answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: 0.95 }])),
      usage: { input_tokens: 100, output_tokens: 0, cost: 0.00001 },
    })
  })
  t.after(() => { release.resolve(); return mf.dispose() })
  // Local HTTP disconnects do not reach request.signal in this Miniflare version.
  // The test-only bundle wrapper aborts a runtime Request after the first model
  // call starts, exercising real Worker -> DO -> Effect cancellation instead.
  const cancelled = await search({ query: 'Synthetic cancellation check' }, '', 'typesafe', undefined, {
    'x-test-cancel-on-model': '1',
  })
  assert.equal(cancelled.status, 502, 'The cancelled API request fails while its model call is pending')
  // Allow cancellation to reach the DO before making the pending response available.
  await delay(100)
  release.resolve()
  await delay(100)
  assert.equal(jevCalls, 1, 'The disconnected search must not issue its judge evaluation')
  // Positive control: the same object remains usable after an interrupted search.
  const next = await search({ query: 'Synthetic next search' })
  assert.equal(next.status, 200)
  assert.equal((await next.json() as SearchResult).usage.requests, 2)
  assert.equal(jevCalls, 3, 'Only the interrupted rating plus the new search rating/judge were issued')
})

test('search-only visitor limits reject before DO routing and leave browsing available', async (t) => {
  let calls = 0
  const { mf, search, request } = await setup(async () => {
    calls++
    return new Response('Public documentation')
  }, 120, { searchLimit: 1 })
  t.after(() => mf.dispose())
  // An invalid body still consumes an admission, but never reaches an upstream.
  assert.equal((await search({ query: '' })).status, 400)
  const limited = await search(undefined, '', 'telegram', undefined, { 'x-test-forbid-routing': '1' })
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('cache-control'), 'no-store')
  assert.equal(calls, 0)
  assert.equal((await request(docsPath)).status, 200)
  assert.equal(calls, 1)
})

test('shared demo limiter applies across visitor IPs and documentation sources before routing', async (t) => {
  let calls = 0
  const { mf, search } = await setup(async () => {
    calls++
    return new Response('must not fetch')
  }, 120, { demoLimit: 1 })
  t.after(() => mf.dispose())
  assert.equal((await search({ query: '' }, '', 'typesafe', undefined, { 'cf-connecting-ip': '192.0.2.1' })).status, 400)
  const limited = await search(undefined, '', 'telegram', undefined, {
    'cf-connecting-ip': '192.0.2.2', 'x-test-forbid-routing': '1',
  })
  assert.equal(limited.status, 429)
  assert.match((await limited.json() as { error: string }).error, /demo is busy/)
  assert.equal(calls, 0)
})

test('origin rules, non-cacheable CORS, unknown API routes and rate limits', async (t) => {
  let calls = 0
  const { mf, request } = await setup(async () => { calls++; return new Response('docs') }, 1)
  t.after(() => mf.dispose())
  assert.equal((await request(docsPath, { headers: { origin: 'https://untrusted.example' } })).status, 403)
  const preflight = await request(docsPath, { method: 'OPTIONS' })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin)
  assert.equal(preflight.headers.get('cache-control'), 'no-store')
  assert.equal((await request('/api/unknown')).status, 404)
  assert.equal((await request(docsPath)).status, 429)
  assert.equal(calls, 0)
})

test('all catalog sources route to separate hostname-named SQLite caches, never ID-named objects', async (t) => {
  const calls: string[] = []
  const { mf, request, storage } = await setup(async (request) => {
    calls.push(request.url)
    const otherLinks = DOCS.map((source) => `[${source.id}](${source.indexUrl})`).join('\n')
    return new Response(`# ${new URL(request.url).hostname}\n[Guide](/guide.md)\n${otherLinks}`, {
      headers: { 'cache-control': 'public, max-age=60' },
    })
  })
  t.after(() => mf.dispose())
  for (const source of DOCS) {
    const response = await request(`/api/page?docs=${source.id}`)
    assert.equal(response.status, 200, await response.clone().text())
    const page = await response.json() as PageResult
    assert.equal(page.url, source.indexUrl)
    assert.ok(page.links.every((link) => new URL(link.url).origin === new URL(source.indexUrl).origin))
    const rows = await (await storage(new URL(source.indexUrl).hostname)).exec<{ url: string }>('SELECT url FROM entries')
    assert.deepEqual(rows, [{ url: source.indexUrl }])
    // An ID-named object rejects even its own catalog ID, confirming names did not silently change.
    const namespace = await mf.getDurableObjectNamespace('HTTP_CACHE')
    const wrong = await namespace.get(namespace.idFromName(source.id)).fetch(`https://api.example/api/page?docs=${source.id}`)
    assert.equal(wrong.status, 400)
    assert.deepEqual(await (await storage(source.id)).exec('SELECT * FROM entries'), [])
    assert.equal((await request(`/api/page?docs=${source.id}`)).status, 200)
  }
  assert.deepEqual(calls, DOCS.map((source) => source.indexUrl))
})

test('missing/unknown selections and search URL overrides are rejected without upstream or model requests', async (t) => {
  let calls = 0
  const { mf, request, search } = await setup(async () => { calls++; return new Response('must not fetch') })
  t.after(() => mf.dispose())
  const headers = { 'x-test-forbid-routing': '1' }
  for (const query of ['', 'docs=', 'docs=unknown', 'url=https://docs.typesafe.ai/llms.txt', 'docs=typesafe&docs=telegram']) {
    assert.equal((await request(`/api/page?${query}`, { headers })).status, 400)
    assert.equal((await request(`/api/search?${query}`, { method: 'POST', headers })).status, 400)
  }
  for (const source of DOCS) {
    const other = DOCS.find((entry) => entry.id !== source.id)!
    for (const url of [other.indexUrl, new URL('/custom.md', source.indexUrl).href, `${source.indexUrl}?x=1`, 'https://127.0.0.1/private']) {
      assert.equal((await search({ query: 'synthetic' }, 'test-key', source.id, url, headers)).status, 400)
    }
    for (const url of [other.indexUrl, 'http://localhost/private', 'https://user:secret@docs.typesafe.ai/llms.txt']) {
      assert.equal((await request(`/api/page?${new URLSearchParams({ docs: source.id, url })}`, { headers })).status, 400)
    }
  }
  assert.equal(calls, 0)
  // Positive control: the hook must fail if a valid selection reaches namespace routing.
  assert.equal((await request('/api/page?docs=typesafe', { headers })).status, 502)
})

test('the DO independently rejects missing selection, URL overrides, and cross-host misrouting', async (t) => {
  let calls = 0
  const { mf } = await setup(async () => { calls++; return new Response('must not fetch') })
  t.after(() => mf.dispose())
  const namespace = await mf.getDurableObjectNamespace('HTTP_CACHE')
  const stub = namespace.get(namespace.idFromName('docs.typesafe.ai'))
  for (const path of [
    '/api/page', '/api/page?docs=unknown', '/api/page?docs=telegram',
    '/api/page?docs=typesafe&url=https://core.telegram.org/llms.txt',
  ]) assert.equal((await stub.fetch(`https://api.example${path}`)).status, 400)
  assert.equal((await stub.fetch('https://api.example/api/search?docs=typesafe&url=https://docs.typesafe.ai/custom.md', { method: 'POST' })).status, 400)
  assert.equal(calls, 0)
})

test('each source searches its fixed registry index with a request-local synthetic model client', async (t) => {
  const docsCalls: string[] = []
  const { mf, search } = await setup(async (request) => {
    if (new URL(request.url).hostname !== 'openrouter.ai') {
      docsCalls.push(request.url)
      return new Response('# Public docs\n\nSynthetic documentation.', { headers: { 'cache-control': 'max-age=60' } })
    }
    assert.equal(request.url, 'https://openrouter.ai/api/v1/systemone')
    assert.equal(request.headers.get('authorization'), 'Bearer synthetic-operator-key')
    const body = await request.json() as { questions: Record<string, unknown> }
    return Response.json({ model: 'jev-test', answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: 0.95 }])), usage: { input_tokens: 100, output_tokens: 0 } })
  })
  t.after(() => mf.dispose())
  for (const source of DOCS) {
    for (const url of [undefined, source.indexUrl]) {
      const response = await search({ query: 'Synthetic question' }, 'synthetic-test-key', source.id, url)
      assert.equal(response.status, 200, await response.clone().text())
      assertSearchDuration(await response.json() as SearchResult)
    }
  }
  assert.deepEqual(docsCalls, DOCS.map((source) => source.indexUrl))
})

test('redirects and HTML fallback redirects cannot cross into another registered source, even with stale cache', async (t) => {
  const calls: string[] = []
  let mode: 'cache' | 'redirect' | 'fallback' = 'cache'
  const { mf, request } = await setup(async (request) => {
    calls.push(request.url)
    const source = DOCS.find((source) => new URL(source.indexUrl).hostname === new URL(request.url).hostname)!
    if (mode === 'cache') return new Response('stale docs', { headers: { 'cache-control': 'max-age=0' } })
    if (mode === 'fallback' && !new URL(request.url).pathname.endsWith('.md')) {
      return new Response('<html>fallback</html>', { headers: { 'content-type': 'text/html' } })
    }
    return new Response(null, { status: 302, headers: { location: DOCS.find((entry) => entry.id !== source.id)!.indexUrl } })
  })
  t.after(() => mf.dispose())
  for (const source of DOCS) {
    mode = 'cache'
    assert.equal((await request(`/api/page?docs=${source.id}`)).status, 200)
    mode = 'redirect'
    assert.equal((await request(`/api/page?docs=${source.id}`)).status, 400)
    mode = 'fallback'
    const page = new URL('/guide', source.indexUrl).href
    assert.equal((await request(`/api/page?${new URLSearchParams({ docs: source.id, url: page })}`)).status, 400)
  }
  assert.equal(calls.length, DOCS.length * 4) // index, stale revalidation, HTML page, Markdown fallback; no cross-site fetch.
})

test('each source allows same-origin redirects and rejects poisoned cache response URLs before any fetch or stale fallback', async (t) => {
  let calls = 0
  const { mf, request, storage } = await setup(async (request) => {
    calls++
    return new URL(request.url).pathname === '/llms.txt'
      ? new Response(null, { status: 302, headers: { location: '/actual.md' } })
      : new Response('same-site docs', { headers: { 'cache-control': 'max-age=60' } })
  })
  t.after(() => mf.dispose())
  for (const source of DOCS) {
    const response = await request(`/api/page?docs=${source.id}`)
    assert.equal(response.status, 200)
    assert.equal((await response.json() as PageResult).url, new URL('/actual.md', source.indexUrl).href)
    const db = await storage(new URL(source.indexUrl).hostname)
    const [row] = await db.exec<{ entry: string }>('SELECT entry FROM entries WHERE url = ?', source.indexUrl)
    const entry = JSON.parse(row!.entry)
    for (const cacheControl of ['max-age=60', 'max-age=0']) {
      entry.cacheControl = cacheControl
      entry.responseUrl = DOCS.find((other) => other.id !== source.id)!.indexUrl
      await db.exec('UPDATE entries SET entry = ? WHERE url = ?', JSON.stringify(entry), source.indexUrl)
      const before = calls
      assert.equal((await request(`/api/page?docs=${source.id}`)).status, 400)
      assert.equal(calls, before)
    }
  }
  assert.equal(calls, DOCS.length * 2)
})

test('Cloudflare-style cookie-setting responses remain fetchable but are not persisted', async (t) => {
  let calls = 0
  const { mf, request, storage } = await setup(async (request) => {
    calls++
    assert.equal(request.url, 'https://developers.cloudflare.com/llms.txt')
    return new Response('Public Cloudflare docs', { headers: { 'cache-control': 'public, max-age=60', 'set-cookie': 'synthetic=not-for-storage' } })
  })
  t.after(() => mf.dispose())
  for (let i = 0; i < 2; i++) assert.equal((await request('/api/page?docs=cloudflare')).status, 200)
  assert.equal(calls, 2)
  assert.deepEqual(await (await storage('developers.cloudflare.com')).exec('SELECT * FROM entries'), [])
})

test('a corrupt cache payload cannot change its key or return a foreign legacy response URL', async (t) => {
  let calls = 0
  const { mf, request, storage } = await setup(async () => {
    calls++
    return new Response('Selected source only', { headers: { 'cache-control': 'max-age=60' } })
  })
  t.after(() => mf.dispose())
  assert.equal((await request(docsPath)).status, 200)
  const db = await storage()
  const [row] = await db.exec<{ entry: string }>('SELECT entry FROM entries')
  const entry = JSON.parse(row!.entry)
  entry.url = 'https://core.telegram.org/llms.txt'
  entry.responseUrl = null
  await db.exec('UPDATE entries SET entry = ?', JSON.stringify(entry))
  const response = await request(docsPath)
  assert.equal(response.status, 200)
  assert.equal((await response.json() as PageResult).url, 'https://docs.typesafe.ai/llms.txt')
  assert.equal(calls, 2)
})
