import type { RequestKind } from '../hooks/useDocumentation'
import { Window } from './Window'
import styles from './RequestFeedback.module.css'

interface RequestFeedbackProps {
  busy: RequestKind | null
  error: string
}

export function RequestFeedback({ busy, error }: RequestFeedbackProps) {
  const searching = busy === 'search'

  return (
    <>
      {busy && (
        <Window
          title={searching ? 'Searching documentation' : 'Opening documentation'}
          meta={<span aria-hidden="true">···</span>}
          role="status"
          variant="loading"
        >
          <p className={styles.message}>
            {searching
              ? 'Following links. Reading passages. Looking for your answer…'
              : 'Loading the original documentation…'}
          </p>
          <div className={styles.progressTrack} aria-hidden="true">
            <div className={styles.progressGrid}>
              <div className={styles.progressBlocks}>
                <span />
                <span />
                <span />
                <span />
              </div>
            </div>
          </div>
          <small>
            {searching
              ? 'This can take a little while. No automatic retries or duplicate requests.'
              : 'Public pages are cached for the next reader.'}
          </small>
        </Window>
      )}
      {error && (
        <Window title="Request failed" role="alert" variant="error">
          {error}
        </Window>
      )}
    </>
  )
}
