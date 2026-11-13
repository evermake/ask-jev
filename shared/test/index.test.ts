import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { DOCS } from '../src/index.ts'

describe('documentation catalog', () => {
  test('contains the expected documentation entries', () => {
    assert.deepEqual(DOCS, [
      { id: 'typesafe', label: 'TypeSafe', indexUrl: 'https://docs.typesafe.ai/llms.txt' },
      { id: 'telegram', label: 'Telegram', indexUrl: 'https://core.telegram.org/llms.txt' },
      { id: 'cloudflare', label: 'Cloudflare', indexUrl: 'https://developers.cloudflare.com/llms.txt' },
    ])
  })

  test('has unique IDs and index URLs', () => {
    assert.equal(new Set(DOCS.map((entry) => entry.id)).size, DOCS.length)
    assert.equal(new Set(DOCS.map((entry) => entry.indexUrl)).size, DOCS.length)
  })

  test('uses clean HTTPS index URLs', () => {
    for (const entry of DOCS) {
      const url = new URL(entry.indexUrl)
      assert.equal(url.protocol, 'https:')
      assert.notEqual(url.hostname, '')
      assert.equal(url.port, '')
      assert.equal(url.username, '')
      assert.equal(url.password, '')
      assert.equal(url.search, '')
      assert.equal(url.hash, '')
      assert.equal(url.pathname, '/llms.txt')
      assert.equal(url.href, entry.indexUrl)
    }
  })
})
