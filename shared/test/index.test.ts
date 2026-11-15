import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { DOCS } from '../src/index.ts'

describe('documentation catalog', () => {
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
