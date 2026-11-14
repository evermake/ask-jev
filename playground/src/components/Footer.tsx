import { SEARCH_BUDGET } from '../config'
import styles from './Footer.module.css'

export function Footer() {
  return (
    <footer className={styles.footer}>
      <p>
        Public docs are cached in Cloudflare Durable Object storage.
        {' '}Questions and search responses are not persisted by this application.
      </p>
      <p>
        The ${SEARCH_BUDGET.toFixed(2)} budget is an estimate, not a billing cap.
        {' '}No automatic retries or speculative duplicate requests.
      </p>
    </footer>
  )
}
