import { describe, test } from 'node:test'
import { expect } from 'expect'
import { ByteSize } from 'effect'
import { DOCS } from '@ask-jev/shared'
import { isSharedCacheable, markdownAlternatives } from 'ask-jev/Documentation'
import {
  docsUrl,
  docsSource,
  docsTarget,
  limitedText,
  MAX_API_SIZE,
  MAX_DOC_SIZE,
  PublicError,
} from '../src/security.ts'

describe('documentation target restrictions', () => {
  test('accepts only the selected source origin, not the union of catalog origins', () => {
    for (const source of DOCS) {
      expect(docsUrl(source.indexUrl, source).href).toBe(source.indexUrl)
      for (const other of DOCS.filter((entry) => entry.id !== source.id)) {
        expect(() => docsUrl(other.indexUrl, source)).toThrow(PublicError)
      }
    }
    const source = docsSource(new URLSearchParams('docs=typesafe'))
    for (const input of [
      'http://docs.typesafe.ai/llms.txt',
      'https://docs.typesafe.ai.evil.com/a',
      'https://user:password@docs.typesafe.ai/a',
      'https://docs.typesafe.ai:444/a',
      'https://docs.typesafe.ai:443/a',
      'https://docs.typesafe.ai/a?token=secret',
      'https://docs.typesafe.ai/a#secret',
      'https://docs.typesafe.ai/a?',
      'https://docs.typesafe.ai/a#',
      'https://127.0.0.1/a',
      'https://[::1]/a',
      'https://localhost/a',
      'https://api.typesafe.ai/v1/systemone',
      'file:///etc/passwd',
    ]) {
      expect(() =>
        docsUrl(input, source),
      ).toThrow(PublicError)
    }
  })

  test('requires a single registered selection and fixes the search index', () => {
    for (const query of ['', 'docs=', 'docs=unknown', 'url=https://docs.typesafe.ai/llms.txt', 'docs=typesafe&docs=telegram']) {
      expect(() => docsSource(new URLSearchParams(query))).toThrow(PublicError)
    }
    for (const source of DOCS) {
      expect(docsTarget(new URLSearchParams(), source, true).href).toBe(source.indexUrl)
      expect(docsTarget(new URLSearchParams({ url: source.indexUrl }), source, true).href).toBe(source.indexUrl)
      expect(() => docsTarget(new URLSearchParams({ url: new URL('/custom.md', source.indexUrl).href }), source, true)).toThrow(PublicError)
      expect(() => docsTarget(new URLSearchParams('url=x&url=y'), source, false)).toThrow(PublicError)
    }
  })

  test('only generates same-origin Markdown fallback URLs', () => {
    expect(markdownAlternatives(new URL('https://docs.typesafe.ai/guide')).map(String)).toEqual([
      'https://docs.typesafe.ai/guide.md',
      'https://docs.typesafe.ai/guide/index.md',
    ])
    expect(markdownAlternatives(new URL('https://docs.typesafe.ai/guide/')).map(String)).toEqual([
      'https://docs.typesafe.ai/guide/index.md',
      'https://docs.typesafe.ai/guide.md',
    ])
  })
})

test('never persists private, cookie-setting, or credential-varying responses', () => {
  for (const headers of [
    { 'cache-control': 'private, max-age=60' },
    { 'cache-control': 'no-store' },
    { 'cache-control': 'public', 'set-cookie': 'session=not-for-storage' },
    { vary: 'Accept, Authorization' },
    { vary: '*' },
    { vary: 'Cookie' },
  ])
    expect(isSharedCacheable(new Headers(headers))).toBe(false)
  expect(
    isSharedCacheable(new Headers({ 'cache-control': 'public, max-age=60', vary: 'Accept' })),
  ).toBe(true)
})

test('limits the actual UTF-8 bytes of a stream', async () => {
  expect(await limitedText(new Response('hello').body, 5)).toBe('hello')
  expect(await limitedText(null, 5)).toBe('')
  await expect(limitedText(new Response('ééé').body, 5)).rejects.toThrow('too large')
})

test('size constants preserve the existing decimal byte limits', () => {
  expect(ByteSize.toNumberUnsafe(MAX_DOC_SIZE)).toBe(1_000_000)
  expect(ByteSize.toNumberUnsafe(MAX_API_SIZE)).toBe(512_000)
})

test('accepts each configured size limit and rejects one byte over it', async () => {
  for (const size of [MAX_DOC_SIZE, MAX_API_SIZE]) {
    const limit = ByteSize.toNumberUnsafe(size)
    const text = 'x'.repeat(limit)
    expect(await limitedText(new Response(text).body, limit)).toBe(text)
    await expect(limitedText(new Response(text + 'x').body, limit)).rejects.toThrow('too large')
  }
})
