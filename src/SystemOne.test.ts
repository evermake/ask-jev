import { expect, test } from 'bun:test'
import { Cause, Effect, Exit, Redacted } from 'effect'
import { FetchHttpClient } from 'effect/http'
import * as SystemOne from './SystemOne.ts'

test('browser Jev client sends only required headers with no cookies, tracing, or redirects', async () => {
  let calls = 0
  const fakeFetch: typeof fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    calls++
    expect(String(input)).toBe('https://worker.example/systemone')
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe('Bearer synthetic-test-key')
    expect(headers.has('traceparent')).toBe(false)
    expect(headers.has('b3')).toBe(false)
    expect(init?.credentials).toBe('omit')
    expect(init?.redirect).toBe('error')
    expect(init?.referrerPolicy).toBe('no-referrer')
    return Response.json({ model: 'jev-test', answers: { q: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 10, output_tokens: 0 } })
  }, { preconnect: fetch.preconnect })
  const response = await Effect.gen(function* () {
    const client = yield* SystemOne.makeWith(Effect.succeed(Redacted.make('synthetic-test-key')), 'https://worker.example/systemone')
    return yield* client.evaluate({ state: 'test', questions: { q: { type: 'noul', instructions: '?' } } })
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
    Effect.runPromise,
  )
  expect(response.noul('q')).toBe(0.9)
  expect(calls).toBe(1)
})

test('client errors never retain an HTTP request containing a visitor key', async () => {
  const fakeFetch: typeof fetch = Object.assign(async () => new Response('private upstream details', { status: 401 }), { preconnect: fetch.preconnect })
  const exit = await Effect.gen(function* () {
    const client = yield* SystemOne.makeWith(Effect.succeed(Redacted.make('synthetic-sensitive-key')), 'https://worker.example/systemone')
    return yield* client.evaluate({ state: 'private-question', questions: { q: { type: 'noul', instructions: '?' } } })
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
    Effect.runPromiseExit,
  )
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    const details = Cause.pretty(exit.cause)
    expect(details).toContain('HTTP 401')
    expect(details).not.toContain('synthetic-sensitive-key')
    expect(details).not.toContain('private-question')
    expect(details).not.toContain('private upstream details')
  }
})
