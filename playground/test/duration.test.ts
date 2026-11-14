import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  formatDuration,
  formatSearchDuration,
  formatSearchDurationBreakdown,
} from '../src/components/SearchResults/duration.ts'

test('formats zero and subsecond durations in milliseconds', () => {
  assert.equal(formatDuration(0), '0ms')
  assert.equal(formatDuration(0.4), '0ms')
  assert.equal(formatDuration(12.6), '13ms')
  assert.equal(formatDuration(600), '600ms')
  assert.equal(formatDuration(999), '999ms')
})

test('formats seconds with one decimal place', () => {
  assert.equal(formatDuration(1000), '1.0s')
  assert.equal(formatDuration(1800), '1.8s')
  assert.equal(formatDuration(2449), '2.4s')
  assert.equal(formatDuration(2451), '2.5s')
})

test('formats minutes and carries rounded seconds into the next minute', () => {
  assert.equal(formatDuration(59_999), '1m 0.0s')
  assert.equal(formatDuration(60_000), '1m 0.0s')
  assert.equal(formatDuration(62_400), '1m 2.4s')
  assert.equal(formatDuration(119_999), '2m 0.0s')
})

test('shows only total duration without labels or a breakdown', () => {
  assert.equal(formatSearchDuration({ totalMs: 6900, jevMs: 1800, restMs: 5100 }), '6.9s')
  assert.equal(formatSearchDuration({ totalMs: 0, jevMs: 0, restMs: 0 }), '0ms')
  assert.equal(formatSearchDuration({ totalMs: 600, jevMs: 0, restMs: 600 }), '600ms')
})

test('keeps total, Jev, and rest in tooltip text without recomputing supplied timings', () => {
  assert.equal(
    formatSearchDurationBreakdown({ totalMs: 2400, jevMs: 1800, restMs: 600 }),
    '2.4s total (1.8s Jev + 600ms rest)',
  )
  assert.equal(
    formatSearchDurationBreakdown({ totalMs: 0, jevMs: 0, restMs: 0 }),
    '0ms total (0ms Jev + 0ms rest)',
  )
  assert.equal(
    formatSearchDurationBreakdown({ totalMs: 600, jevMs: 0, restMs: 600 }),
    '600ms total (0ms Jev + 600ms rest)',
  )
})
