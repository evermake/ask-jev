import type { SearchResult } from '@ask-jev/api/contracts'
import { LinkButton } from '../LinkButton'
import styles from './SearchResults.module.css'

interface PagesExploredProps {
  pages: SearchResult['pages']
  disabled: boolean
  onOpenPage: (path: string) => void
}

export function PagesExplored({ pages, disabled, onOpenPage }: PagesExploredProps) {
  return (
    <details>
      <summary>Pages explored ({pages.length})</summary>
      <ul>
        {pages.map((page) => (
          <li key={page.path}>
            <LinkButton disabled={disabled} onClick={() => onOpenPage(page.path)}>
              {page.path}
            </LinkButton>
            <span className={styles.pageStatus}>
              {' — '}{page.error ?? (page.round ? `read in round ${page.round}` : 'not followed')}
            </span>
          </li>
        ))}
      </ul>
    </details>
  )
}
