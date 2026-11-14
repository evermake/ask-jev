import assert from 'node:assert/strict'
import { after, afterEach, beforeEach, mock, test } from 'node:test'
import type { SearchResult } from '@ask-jev/api/contracts'
import { loadDocumentation, searchDocumentation } from '../src/api.ts'

const origin = 'https://ask-jev.example'
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')

function setOrigin(value: string) {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: value } },
  })
}

beforeEach(() => setOrigin(origin))

afterEach(() => mock.restoreAll())

after(() => {
  if (windowDescriptor) {
    Object.defineProperty(globalThis, 'window', windowDescriptor)
  } else {
    Reflect.deleteProperty(globalThis, 'window')
  }
})

test('browses the selected index without credentials or a request body', async () => {
  const page = { url: 'https://docs.typesafe.ai/llms.txt', content: 'Index', links: [], toc: [] }
  const fetch = mock.method(globalThis, 'fetch', async () => Response.json(page))
  const signal = new AbortController().signal

  assert.deepEqual(await loadDocumentation({ docs: 'typesafe', signal }), page)

  const [url, options] = fetch.mock.calls[0]!.arguments
  assert.equal(String(url), `${origin}/api/page?docs=typesafe`)
  assert.equal(options?.method, 'GET')
  assert.equal(options?.credentials, 'omit')
  assert.equal(options?.referrerPolicy, 'no-referrer')
  assert.equal(options?.signal, signal)
  assert.equal(options?.headers, undefined)
  assert.equal(options?.body, undefined)
  assert.equal(fetch.mock.callCount(), 1)
})

test('encodes an explicit documentation page in the browse URL', async () => {
  const fetch = mock.method(globalThis, 'fetch', async () => Response.json({}))
  const pageUrl = 'https://developers.cloudflare.com/workers/'

  await loadDocumentation({
    docs: 'cloudflare',
    signal: new AbortController().signal,
    url: pageUrl,
  })

  const endpoint = new URL(String(fetch.mock.calls[0]!.arguments[0]))
  assert.equal(endpoint.pathname, '/api/page')
  assert.equal(endpoint.searchParams.get('docs'), 'cloudflare')
  assert.equal(endpoint.searchParams.get('url'), pageUrl)
})

test('searches with a fixed budget, preserves duration, and keeps the key and question out of the URL', async () => {
  const result = {
    query: 'How do retries work?',
    answered: 0.9,
    stopped: 'answered',
    pages: [],
    passages: [],
    rounds: [],
    usage: { requests: 2, inputTokens: 1200, cost: 0.0012 },
    duration: { totalMs: 2400, jevMs: 1800, restMs: 600 },
    model: 'jev-preview',
  } satisfies SearchResult
  const fetch = mock.method(globalThis, 'fetch', async () => Response.json(result))
  const signal = new AbortController().signal

  assert.deepEqual(await searchDocumentation({
    docs: 'telegram',
    signal,
    question: { query: 'How do retries work?', model: 'jev-preview' },
    apiKey: 'synthetic-test-key',
  }), result)

  const [url, options] = fetch.mock.calls[0]!.arguments
  assert.equal(String(url), `${origin}/api/search?docs=telegram`)
  assert.equal(options?.method, 'POST')
  assert.equal(options?.credentials, 'omit')
  assert.equal(options?.referrerPolicy, 'no-referrer')
  assert.equal(options?.signal, signal)
  assert.deepEqual(options?.headers, {
    'content-type': 'application/json',
    authorization: 'Bearer synthetic-test-key',
  })
  assert.deepEqual(JSON.parse(String(options?.body)), {
    query: 'How do retries work?',
    budget: 0.02,
    model: 'jev-preview',
  })
  assert.equal(fetch.mock.callCount(), 1)
})

test('surfaces API errors without automatically retrying', async () => {
  const fetch = mock.method(globalThis, 'fetch', async () => (
    Response.json({ error: 'Too many requests.' }, { status: 429 })
  ))

  await assert.rejects(
    searchDocumentation({
      docs: 'typesafe',
      signal: new AbortController().signal,
      question: { query: 'Timeouts?', model: 'jev-latest' },
      apiKey: 'synthetic-test-key',
    }),
    { message: 'Too many requests.' },
  )
  assert.equal(fetch.mock.callCount(), 1)
})

test('uses a fallback message when an unsuccessful response has no error text', async () => {
  mock.method(globalThis, 'fetch', async () => Response.json({}, { status: 500 }))

  await assert.rejects(
    loadDocumentation({ docs: 'typesafe', signal: new AbortController().signal }),
    { message: 'Request failed.' },
  )
})

test('explains how to start the local API when the dev proxy returns an empty response', async () => {
  setOrigin('http://127.0.0.1:5173')
  const fetch = mock.method(globalThis, 'fetch', async () => new Response(null, { status: 502 }))

  await assert.rejects(
    loadDocumentation({ docs: 'typesafe', signal: new AbortController().signal }),
    {
      message: 'API returned an invalid response (HTTP 502). Make sure the local API is running: pnpm --filter @ask-jev/api dev.',
    },
  )
  assert.equal(fetch.mock.callCount(), 1)
})

test('does not expose unexpected HTML or parser errors to the user', async () => {
  mock.method(globalThis, 'fetch', async () => new Response('<html>Internal details</html>'))

  await assert.rejects(
    loadDocumentation({ docs: 'typesafe', signal: new AbortController().signal }),
    { message: 'API returned an invalid response (HTTP 200). Please try again.' },
  )
})

test('preserves cancellation while reading the response body', async () => {
  const controller = new AbortController()
  const response = Response.json({})
  mock.method(response, 'json', async () => {
    controller.abort()
    throw controller.signal.reason
  })
  mock.method(globalThis, 'fetch', async () => response)

  await assert.rejects(
    loadDocumentation({ docs: 'typesafe', signal: controller.signal }),
    { name: 'AbortError' },
  )
})

test('propagates request cancellation without retrying', async () => {
  const fetch = mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, options?: RequestInit) => {
    options?.signal?.throwIfAborted()
    return Response.json({})
  })
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    loadDocumentation({ docs: 'typesafe', signal: controller.signal }),
    { name: 'AbortError' },
  )
  assert.equal(fetch.mock.callCount(), 1)
})
