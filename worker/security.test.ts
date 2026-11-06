import { describe, expect, test } from 'bun:test'
import {
  docsUrl,
  isSharedCacheable,
  limitedText,
  markdownAlternatives,
  PublicError,
} from './security.ts'

describe('documentation target restrictions', () => {
  test('accepts only exact, approved HTTPS documentation hosts', () => {
    expect(docsUrl('https://docs.typesafe.ai/llms.txt', 'docs.typesafe.ai').href).toBe(
      'https://docs.typesafe.ai/llms.txt',
    )
    for (const input of [
      'http://docs.typesafe.ai/llms.txt',
      'https://docs.typesafe.ai.evil.com/a',
      'https://user:password@docs.typesafe.ai/a',
      'https://docs.typesafe.ai:444/a',
      'https://docs.typesafe.ai/a?token=secret',
      'https://docs.typesafe.ai/a#secret',
      'https://127.0.0.1/a',
      'https://[::1]/a',
      'https://localhost/a',
      'https://api.typesafe.ai/v1/systemone',
      'file:///etc/passwd',
    ]) {
      expect(() =>
        docsUrl(input, 'docs.typesafe.ai,127.0.0.1,[::1],localhost,api.typesafe.ai'),
      ).toThrow(PublicError)
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
