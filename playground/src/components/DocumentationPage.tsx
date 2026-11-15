import type { PageResult } from '@ask-jev/api/contracts'
import { LinkButton } from './LinkButton'
import { ScrollArea } from './ScrollArea'
import { Window } from './Window'
import styles from './DocumentationPage.module.css'

interface DocumentationPageProps {
  page: PageResult
  disabled: boolean
  onBrowse: (url: string) => void
}

export function DocumentationPage({ page, disabled, onBrowse }: DocumentationPageProps) {
  return (
    <Window title={page.url.replace(/^https?:\/\//, '')} meta="Document" label="Documentation page">
      <ScrollArea className={styles.content} label="Page content">
        {page.content}
      </ScrollArea>
      {page.links.length > 0 && (
        <details key={page.url}>
          <summary>Linked pages ({page.links.length})</summary>
          <ScrollArea as="ul" className={styles.links} label="Linked pages">
            {page.links.map((link) => (
              <li key={link.url}>
                <LinkButton
                  className={styles.link}
                  disabled={disabled}
                  onClick={() => onBrowse(link.url)}
                >
                  {link.text}
                </LinkButton>
              </li>
            ))}
          </ScrollArea>
        </details>
      )}
    </Window>
  )
}
