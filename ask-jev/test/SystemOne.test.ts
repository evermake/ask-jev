import { test } from 'node:test'
import { expect } from 'expect'
import { Cause, Effect, Exit, Redacted, Schema } from 'effect'
import { FetchHttpClient } from 'effect/http'
import * as SystemOne from '../src/SystemOne.ts'

const key = Effect.succeed(Redacted.make('synthetic-test-key'))
const questions = {
  q: { type: 'noul', instructions: '?' },
  choice: { type: 'choice', instructions: 'Pick one', criteria: { a: 'A', b: null } },
  score: { type: 'score', instructions: 'Rate', criteria: ['Low', 'High'] },
} satisfies Record<string, SystemOne.Question>
const openRouterResponse = {
  model: 'typesafe/jev-1.13-20260917',
  answers: {
    q: { type: 'noul', noul: 0.9 },
    choice: { type: 'choice', choice: 'a', probabilities: { a: 0.8, b: 0.2 }, confidence: 0.8 },
    score: { type: 'score', score: 1, probabilities: { '0': 0.1, '1': 0.9 }, confidence: 0.9 },
  },
  usage: { input_tokens: 100, output_tokens: 0, cost: 0.0000123 },
}

for (const model of [undefined, 'jev-preview', 'typesafe/jev-1.13-20260917']) {
  test(`OpenRouter layer sends typed questions with model ${model ?? 'default'}`, async () => {
    let calls = 0
    const request: SystemOne.Request = {
      state: { private: 'synthetic state' },
      questions,
      ...(model === undefined ? {} : { model }),
    }
    const fakeFetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls++
      expect(String(input)).toBe('https://openrouter.ai/api/v1/systemone')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({
        ...request,
        model: model ?? SystemOne.DEFAULT_MODEL,
      })
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer synthetic-test-key')
      expect(headers.get('content-type')).toContain('application/json')
      expect(headers.has('traceparent')).toBe(false)
      expect(headers.has('b3')).toBe(false)
      expect(init?.credentials).toBe('omit')
      expect(init?.redirect).toBe('error')
      expect(init?.referrerPolicy).toBe('no-referrer')
      return Response.json(openRouterResponse)
    })
    const response = await Effect.gen(function* () {
      const client = yield* SystemOne.SystemOne
      return yield* client.evaluate(request)
    }).pipe(
      Effect.provide(SystemOne.layerOpenRouter(key)),
      Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
      Effect.runPromise,
    )
    expect(response.model).toBe(openRouterResponse.model)
    expect(response.noul('q')).toBe(0.9)
    expect(response.probabilities('choice')).toEqual({ a: 0.8, b: 0.2 })
    expect(response.answers.score).toEqual(openRouterResponse.answers.score)
    expect(response.usage).toEqual(openRouterResponse.usage)
    expect(calls).toBe(1)
  })
}

for (const [name, make, endpoint] of [
  ['default TypeSafe', () => SystemOne.makeWith(key), SystemOne.TYPESAFE_ENDPOINT],
  ['OpenRouter factory', () => SystemOne.makeOpenRouter(key), SystemOne.OPENROUTER_ENDPOINT],
  ['OpenRouter positional endpoint', () => SystemOne.makeWith(key, SystemOne.OPENROUTER_ENDPOINT), SystemOne.OPENROUTER_ENDPOINT],
] as const) {
  test(`${name} preserves injectable HTTP client and defaults to no retries`, async () => {
    let calls = 0
    const fakeFetch: typeof fetch = (async (input: string | URL | Request) => {
      calls++
      expect(String(input)).toBe(endpoint)
      return new Response('private provider details', { status: 529 })
    })
    const exit = await Effect.gen(function* () {
      const client = yield* make()
      return yield* client.evaluate({ state: 'private state', questions })
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
      Effect.runPromiseExit,
    )
    expect(calls).toBe(1)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const details = Cause.pretty(exit.cause)
      expect(details).toContain('System One returned HTTP 529')
      expect(details).not.toContain('synthetic-test-key')
      expect(details).not.toContain('private state')
      expect(details).not.toContain('private provider details')
    }
  })
}

test('response decodes optional finite nonnegative USD cost, including zero', () => {
  const decode = Schema.decodeUnknownSync(SystemOne.Response)
  for (const cost of [0, 0.0000123, 1]) {
    expect(decode({ ...openRouterResponse, usage: { ...openRouterResponse.usage, cost } }).usage.cost).toBe(cost)
  }
  expect(decode({ ...openRouterResponse, usage: { input_tokens: 100, output_tokens: 0 } }).usage.cost).toBeUndefined()
  for (const cost of [-1, NaN, Infinity, -Infinity, null, '0.01']) {
    expect(() => decode({ ...openRouterResponse, usage: { ...openRouterResponse.usage, cost } })).toThrow()
  }
})

test('Jev client sends only required headers with no cookies, tracing, or redirects', async () => {
  let calls = 0
  const fakeFetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
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
  })
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
  const fakeFetch: typeof fetch = (async () => new Response('private upstream details', { status: 401 }))
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
