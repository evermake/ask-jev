import type { ComponentProps } from 'react'
import styles from './LinkButton.module.css'

export function LinkButton({ children, className = '', ...props }: ComponentProps<'button'>) {
  return (
    <button {...props} type="button" className={`${styles.link} ${className}`}>
      {children}
    </button>
  )
}
