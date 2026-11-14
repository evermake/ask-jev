import type { SearchResult } from '@ask-jev/api/contracts'
import { LinkButton } from '../LinkButton'
import styles from './Passage.module.css'

interface PassageProps {
  passage: SearchResult['passages'][number]
  number: number
  disabled: boolean
  onOpenPage: (path: string) => void
}

export function Passage({ passage, number, disabled, onOpenPage }: PassageProps) {
  return (
    <article className={styles.passage}>
      <div className={styles.heading}>
        <div className={styles.source}>
          <span className={styles.number} aria-hidden="true">
            {String(number).padStart(2, '0')}
          </span>
          <LinkButton
            disabled={disabled}
            onClick={() => onOpenPage(passage.path)}
            title={passage.headings.length > 0 ? passage.headings.join(' › ') : undefined}
          >
            {passage.path}
          </LinkButton>
        </div>
        <span className={styles.badge}>
          {Math.round(passage.relevance * 100)}% relevance
        </span>
      </div>
      <pre>{passage.text}</pre>
    </article>
  )
}
