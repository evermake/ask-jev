import type { SearchResult } from '@ask-jev/api/contracts'

export function formatDuration(milliseconds: number) {
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`

  const seconds = Math.round(milliseconds / 100) / 10
  if (seconds < 60) return `${seconds.toFixed(1)}s`

  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s`
}

export function formatSearchDuration(duration: SearchResult['duration']) {
  return formatDuration(duration.totalMs)
}

export function formatSearchDurationBreakdown(duration: SearchResult['duration']) {
  return `${formatDuration(duration.totalMs)} total (${formatDuration(duration.jevMs)} Jev + ${formatDuration(duration.restMs)} rest)`
}
