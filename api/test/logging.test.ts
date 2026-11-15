import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DocsResolver, SystemOne } from 'ask-jev'
import { logError } from '../src/logging.ts'
import { PublicError } from '../src/security.ts'

test('logs native errors with original stack frames but no unknown messages or nested causes', (t) => {
  const errors: Error[] = []
  t.mock.method(console, 'error', (error: Error, stack: string) => {
    assert.equal(stack, error.stack)
    errors.push(error)
  })
  const original = new Error('synthetic-private-message\n    at synthetic-private-detail:1:2', {
    cause: new Error('synthetic-private-cause'),
  })
  Object.assign(original, { request: { authorization: 'synthetic-private-key' } })
  logError(original)
  const diagnostic = errors[0]!
  assert.ok(diagnostic instanceof Error, 'Workers needs an Error object, not a serialized stack string')
  assert.match(diagnostic.stack!, /logging\.test\.ts:\d+:\d+/)
  assert.equal(diagnostic.cause, undefined)
  assert.equal(diagnostic.message, 'Unexpected server error.')
  assert.ok(!`${diagnostic.stack}${JSON.stringify(diagnostic)}`.includes('synthetic-private'))
})

test('preserves known safe messages and never logs attached URL or cause fields', (t) => {
  const errors: Error[] = []
  t.mock.method(console, 'error', (error: Error) => { errors.push(error) })
  for (const original of [
    new SystemOne.SystemOneError({ message: 'System One returned HTTP 402.', cause: new Error('synthetic-private-cause') }),
    new DocsResolver.DocsResolverError({ message: 'Documentation request failed.', url: 'https://synthetic-private-url.example/' }),
    new PublicError('Demo search is not configured.', 503),
  ]) {
    logError(original)
    const diagnostic = errors.at(-1)!
    assert.equal(diagnostic.message, original.message)
    assert.match(diagnostic.stack!, /\bat .*logging\.test\.ts:\d+:\d+/)
    assert.ok(!`${diagnostic.stack}${JSON.stringify(diagnostic)}`.includes('synthetic-private'))
  }
})
