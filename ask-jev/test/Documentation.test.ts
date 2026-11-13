import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Effect, Layer } from 'effect'
import * as Documentation from '../src/Documentation.ts'
import { DocsResolver, DocsResolverError } from '../src/DocsResolver.ts'
import type { CachedResponse } from '../src/HttpCache.ts'

const url = new URL('https://docs.example.com/guide')
const setup = (get: (url: URL, headers: Record<string, string>) => Effect.Effect<Response, DocsResolverError>) => {
  const entries = new Map<string, CachedResponse>()
  const validated: string[] = []
  const layer = Documentation.layer.pipe(Layer.provide(Layer.mergeAll(
    Layer.succeed(Documentation.CacheStorage, {
      get: (url) => Effect.sync(() => entries.get(url)),
      set: (entry) => Effect.sync(() => { entries.set(entry.url, entry) }),
      remove: (url) => Effect.sync(() => { entries.delete(url) }),
    }),
    Layer.succeed(Documentation.DocsTransport, { get }),
    Layer.succeed(Documentation.DocsPolicy, {
      maxBytes: 100,
      validate: (target) => {
        validated.push(target.href)
        return target.origin === url.origin ? Effect.void
          : Effect.fail(new DocsResolverError({ url: target.href, message: 'Forbidden target', status: 400 }))
      },
    }),
  )))
  const load = (target = url) => Effect.gen(function* () {
    return yield* (yield* DocsResolver).fetch(target)
  }).pipe(Effect.provide(layer), Effect.runPromise)
  return { entries, validated, load }
}

test('portable adapters support conditional cache revalidation', async () => {
  let calls = 0
  const { entries, load } = setup((_url, headers) => Effect.sync(() => {
    calls++
    if (calls === 1) return new Response('docs', { headers: { etag: 'v1', 'cache-control': 'max-age=0' } })
    assert.equal(headers['if-none-match'], 'v1')
    return new Response(null, { status: 304, headers: { 'cache-control': 'max-age=3600' } })
  }))
  assert.equal((await load()).content, 'docs')
  assert.equal((await load()).content, 'docs')
  assert.equal((await load()).content, 'docs')
  assert.equal(calls, 2)
  assert.equal(entries.size, 1)
})

test('serves stale on transport/5xx failure, but respects must-revalidate', async () => {
  let mode = 'ok'
  const { load } = setup(() => mode === 'offline'
    ? Effect.fail(new DocsResolverError({ url: url.href, message: 'offline' }))
    : Effect.succeed(new Response('docs', { status: mode === '500' ? 500 : 200, headers: { 'cache-control': 'max-age=0' } })))
  await load()
  mode = 'offline'
  assert.equal((await load()).content, 'docs')
  mode = '500'
  assert.equal((await load()).content, 'docs')
  let offline = false
  const strict = setup(() => offline ? Effect.fail(new DocsResolverError({ url: url.href, message: 'offline' }))
    : Effect.succeed(new Response('docs', { headers: { 'cache-control': 'max-age=0, must-revalidate' } })))
  await strict.load()
  offline = true
  await assert.rejects(strict.load(), /offline/)
})

test('never stores private/no-store/cookie/credential-varying docs', async () => {
  for (const headers of [
    { 'cache-control': 'private' }, { 'cache-control': 'no-store' },
    { 'set-cookie': 'private' }, { vary: 'Authorization' },
  ]) {
    const { entries, load } = setup(() => Effect.succeed(new Response('docs', { headers })))
    await load()
    assert.equal(entries.size, 0)
  }
})

test('unsafe redirects never produce stale success; validators are dropped across safe redirects', async () => {
  let redirect = false
  const { load } = setup(() => Effect.succeed(redirect
    ? new Response(null, { status: 302, headers: { location: 'https://forbidden.example/secret' } })
    : new Response('old', { headers: { 'cache-control': 'max-age=0' } })))
  await load()
  redirect = true
  await assert.rejects(load(), /Forbidden target/)
  let phase = 0
  const safe = setup((target, headers) => Effect.sync(() => {
    if (phase++ === 0) return new Response('old', { headers: { 'cache-control': 'max-age=0', etag: 'v1' } })
    if (target.href === url.href) {
      assert.equal(headers['if-none-match'], 'v1')
      return new Response(null, { status: 302, headers: { location: '/actual.md' } })
    }
    assert.deepEqual(headers, {})
    return new Response('new')
  }))
  await safe.load()
  assert.equal((await safe.load()).url.href, 'https://docs.example.com/actual.md')
})

test('fallbacks resolve against actual URLs and oversized bodies are not cached', async () => {
  const { load } = setup((target) => Effect.succeed(target.pathname.endsWith('.md')
    ? new Response('markdown') : new Response('<html>HTML</html>')))
  assert.equal((await load()).url.href, 'https://docs.example.com/guide.md')
  const large = setup(() => Effect.succeed(new Response('é'.repeat(100))))
  await assert.rejects(large.load(), /too large/)
  assert.equal(large.entries.size, 0)
})
