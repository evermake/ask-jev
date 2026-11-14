import type { SearchResult } from '@ask-jev/api/contracts'

const stopReasonLabels: Record<SearchResult['stopped'], string> = {
  answered: 'Answer found',
  exhausted: 'No more promising pages',
  budget: 'Budget reached',
  'max-pages': 'Page limit reached',
}

export function formatStopReason(reason: SearchResult['stopped']) {
  return stopReasonLabels[reason]
}

export function formatTokenCount(tokens: number) {
  if (tokens < 1000) return String(tokens)

  const divisor = tokens >= 1_000_000 ? 1_000_000 : 1000
  const suffix = tokens >= 1_000_000 ? 'M' : 'K'
  return `${(tokens / divisor).toFixed(1).replace('.', ',')}${suffix}`
}
