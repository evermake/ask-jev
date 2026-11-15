import type { ReactNode } from 'react'
import styles from './ScrollArea.module.css'

interface ScrollAreaProps {
  as?: 'pre' | 'ul'
  label: string
  className?: string | undefined
  children: ReactNode
}

export function ScrollArea({ as: Tag = 'pre', label, className = '', children }: ScrollAreaProps) {
  return (
    <Tag className={`${styles.area} ${className}`} tabIndex={0} aria-label={label}>
      {children}
    </Tag>
  )
}
