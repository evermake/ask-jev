import type { SearchResult } from '@ask-jev/api/contracts'
import { Window } from '../Window'
import { PagesExplored } from './PagesExplored'
import { Passage } from './Passage'
import { formatSearchDuration, formatSearchDurationBreakdown } from './duration'
import { formatStopReason, formatTokenCount } from './stats'
import styles from './SearchResults.module.css'

interface SearchResultsProps {
  result: SearchResult
  disabled: boolean
  onOpenPage: (path: string) => void
}

export function SearchResults({ result, disabled, onOpenPage }: SearchResultsProps) {
  const duration = formatSearchDuration(result.duration)
  const durationExplanation = 'Server-side core search execution, including documentation loading and passage selection, not browser-observed request time. Jev is wall-clock time in logical SystemOne.evaluate calls; overlapping calls count once. Rest is total minus Jev.'
  const durationDetails = `${formatSearchDurationBreakdown(result.duration)}. ${durationExplanation}`
  const stats = [
    { value: duration, title: durationDetails, ariaLabel: durationDetails },
    { value: `$${result.usage.cost.toFixed(6)}` },
    {
      value: formatTokenCount(result.usage.inputTokens),
      ariaLabel: `${result.usage.inputTokens} input tokens`,
      title: `${result.usage.inputTokens.toLocaleString()} input tokens`,
    },
    { value: `${result.usage.requests} requests` },
    { value: result.model || 'no model requests' },
  ]

  return (
    <Window
      title={formatStopReason(result.stopped)}
      meta={`${Math.round(result.answered * 100)}% confidence`}
      label="Search results"
    >
      <div className={styles.stats}>
        {stats.map((stat, index) => (
          <span className={styles.stat} key={index}>
            <span title={stat.title} aria-label={stat.ariaLabel}>{stat.value}</span>
            {index < stats.length - 1 && (
              <span className={styles.separator} aria-hidden="true">•</span>
            )}
          </span>
        ))}
      </div>
      {result.passages.map((passage, index) => (
        <Passage
          key={`${passage.path}:${passage.start}`}
          passage={passage}
          number={index + 1}
          disabled={disabled}
          onOpenPage={onOpenPage}
        />
      ))}
      {result.passages.length === 0 && (
        <p>No matching passages. Try a broader question.</p>
      )}
      <PagesExplored pages={result.pages} disabled={disabled} onOpenPage={onOpenPage} />
    </Window>
  )
}
