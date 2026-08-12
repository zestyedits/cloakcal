'use client'

import { useEffect, useRef } from 'react'
import type { CloakSubjectType } from '@cloakcal/cloak-store'
import { useCloakedValue } from './use-cloaked-value'
import styles from './cloaked-text.module.css'

/**
 * Renders one Cloaked field.
 *
 * Subscribes to exactly one field key through useCloakedValue, so a decrypted value never
 * passes through props, context-as-data, or any parent's render output. The value exists in
 * this component and nowhere else.
 *
 * THE REVEAL. When the value becomes readable after a placeholder was actually painted,
 * it plays the uncloak wipe (cloaked-text.module.css). The placeholder-first condition is
 * tracked in an effect — effects run after paint, so the flag is only set when a sealed
 * state genuinely reached the screen. A value that was readable from the first frame has
 * nothing to reveal, and animating it would turn every fast render into theatre.
 */
export function CloakedText({
  subjectType,
  subjectId,
  fieldName,
  placeholder = 'Private',
  className,
}: {
  subjectType: CloakSubjectType
  subjectId: string
  fieldName: string
  // `| undefined` is required under exactOptionalPropertyTypes: CSS-module class lookups
  // are typed `string | undefined`, and the strict flag distinguishes "absent" from
  // "present but undefined".
  placeholder?: string | undefined
  className?: string | undefined
}) {
  const snapshot = useCloakedValue(subjectType, subjectId, fieldName)

  const paintedPlaceholder = useRef(false)
  useEffect(() => {
    if (snapshot.status !== 'ready') paintedPlaceholder.current = true
  })

  if (snapshot.status === 'ready') {
    const revealClass = paintedPlaceholder.current
      ? className === undefined
        ? styles.reveal
        : `${className} ${styles.reveal}`
      : className
    return <span className={revealClass}>{snapshot.value}</span>
  }
  if (snapshot.status === 'error') {
    return (
      <span className={className} data-cloak-state="error" title={snapshot.reason}>
        Unable to decrypt
      </span>
    )
  }
  return (
    <span className={className} data-cloak-state={snapshot.status}>
      {placeholder}
    </span>
  )
}
