import type { ReactNode } from 'react'
import styles from './Window.module.css'

interface WindowProps {
  title: string
  meta?: ReactNode
  label?: string
  role?: 'status' | 'alert'
  variant?: 'loading' | 'error'
  children: ReactNode
}

export function Window({ title, meta, label, role, variant, children }: WindowProps) {
  const className = variant ? `${styles.window} ${styles[variant]}` : styles.window

  return (
    <section
      className={className}
      aria-label={label}
      role={role}
      aria-live={role === 'status' ? 'polite' : undefined}
    >
      <div className={styles.titleBar}>
        {label ? <h2>{title}</h2> : <span>{title}</span>}
        {meta && <span className={styles.meta}>{meta}</span>}
      </div>
      <div className={styles.body}>{children}</div>
    </section>
  )
}
