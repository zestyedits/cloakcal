'use client'

import type { ReactNode } from 'react'
import styles from './inline-error.module.css'

/**
 * The inline error block. `role="alert"` so it is announced the moment it renders —
 * which is also why callers should render it conditionally rather than leaving an empty
 * alert region in the tree.
 *
 * This replaces six hand-rolled copies of the same markup (unlock, change-password,
 * reissue-phrase, new/edit/delete event). Error STATE stays in the callers — what went
 * wrong is their business; how it looks is nobody's business but this file's.
 *
 * Passing `null` renders nothing, so call sites can write
 * `<InlineError>{error}</InlineError>` without their own conditional.
 */
export function InlineError({
  children,
  className,
}: {
  children: ReactNode
  className?: string | undefined
}) {
  if (children === null || children === undefined || children === false || children === '') {
    return null
  }
  return (
    <p role="alert" className={className ? `${styles.error} ${className}` : styles.error}>
      {children}
    </p>
  )
}
