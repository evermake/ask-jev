import type { PageResult } from '@ask-jev/api/contracts'
import { LinkButton } from './LinkButton'
import { Window } from './Window'
import styles from './DocumentationPage.module.css'

interface DocumentationPageProps {
  page: PageResult
  disabled: boolean
  onBrowse: (url: string) => void
}

export function DocumentationPage({ page, disabled, onBrowse }: DocumentationPageProps) {
  return (
    <Window title={new URL(page.url).pathname} meta="Document" label="Documentation page">
      <p className={styles.url}>{page.url}</p>
      {page.links.length > 0 && (
        <details open>
          <summary>Linked pages ({page.links.length})</summary>
          <ul className={styles.links}>
            {page.links.map((link) => (
              <li key={link.url}>
                <LinkButton disabled={disabled} onClick={() => onBrowse(link.url)}>
                  {link.text}
                </LinkButton>
              </li>
            ))}
          </ul>
        </details>
      )}
      <details open>
        <summary>Page content</summary>
        <pre>{page.content}</pre>
      </details>
    </Window>
  )
}
