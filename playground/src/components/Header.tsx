import styles from './Header.module.css'

export function Header() {
  return (
    <header className={styles.header}>
      <span>Ask Jev</span>
      <span className={styles.divider} aria-hidden="true">/</span>
      <a href="https://github.com/evermake/ask-jev" target="_blank" rel="noopener noreferrer">
        Source on GitHub <span aria-hidden="true">↗</span>
      </a>
    </header>
  )
}
