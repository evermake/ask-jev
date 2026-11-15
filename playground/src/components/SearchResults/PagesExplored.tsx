import type { SearchResult } from '@ask-jev/api/contracts'
import { LinkButton } from '../LinkButton'
import { ScrollArea } from '../ScrollArea'
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
      <ScrollArea as="ul" className={styles.pages} label="Pages explored">
        {pages.map((page) => (
          <li key={page.path}>
            <LinkButton className={styles.pageLink} disabled={disabled} onClick={() => onOpenPage(page.path)}>
              {page.path}
            </LinkButton>
            <span className={styles.pageStatus}>
              {' — '}{page.error ?? (page.round ? `read in round ${page.round}` : 'not followed')}
            </span>
          </li>
        ))}
      </ScrollArea>
    </details>
  )
}
