import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatStopReason, formatTokenCount } from '../src/components/SearchResults/stats.ts'

test('formats an answered stop reason', () => {
  assert.equal(formatStopReason('answered'), 'Answer found')
})

test('formats an exhausted stop reason', () => {
  assert.equal(formatStopReason('exhausted'), 'No more promising pages')
})

test('formats a budget stop reason', () => {
  assert.equal(formatStopReason('budget'), 'Budget reached')
})

test('formats a page-limit stop reason', () => {
  assert.equal(formatStopReason('max-pages'), 'Page limit reached')
})

test('keeps token counts below one thousand as integers', () => {
  assert.equal(formatTokenCount(0), '0')
  assert.equal(formatTokenCount(1), '1')
  assert.equal(formatTokenCount(999), '999')
})

test('abbreviates thousands with one comma decimal and no visible token label', () => {
  assert.equal(formatTokenCount(1000), '1,0K')
  assert.equal(formatTokenCount(14_733), '14,7K')
  assert.equal(formatTokenCount(14_750), '14,8K')
  assert.equal(formatTokenCount(100_000), '100,0K')
})

test('abbreviates millions consistently', () => {
  assert.equal(formatTokenCount(1_000_000), '1,0M')
  assert.equal(formatTokenCount(1_234_567), '1,2M')
  assert.equal(formatTokenCount(14_750_000), '14,8M')
})
