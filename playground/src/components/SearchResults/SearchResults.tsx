import type { SearchResult } from '@ask-jev/api/contracts'
import { Window } from '../Window'
import { PagesExplored } from './PagesExplored'
import { Passage } from './Passage'
import styles from './SearchResults.module.css'

interface SearchResultsProps {
  result: SearchResult
  disabled: boolean
  onOpenPage: (path: string) => void
}

function answerTitle(confidence: number) {
  if (confidence >= 0.7) return 'Answer found'
  if (confidence >= 0.35) return 'Partially answered'
  return 'No confident answer'
}

export function SearchResults({ result, disabled, onOpenPage }: SearchResultsProps) {
  return (
    <Window
      title={answerTitle(result.answered)}
      meta={`${Math.round(result.answered * 100)}% confidence`}
      label="Search results"
    >
      <div className={styles.stats}>
        <span>Stopped: {result.stopped}</span>
        <span>{result.usage.requests} requests</span>
        <span>{result.usage.inputTokens.toLocaleString()} input tokens</span>
        <span>${result.usage.cost.toFixed(6)}</span>
        <span>{result.model || 'no model requests'}</span>
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
