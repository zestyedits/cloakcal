'use client'

import type { CloakSubjectType } from '@cloakcal/cloak-store'
import { useCloakedValue } from './use-cloaked-value'

/**
 * Renders one Cloaked field.
 *
 * Subscribes to exactly one field key through useCloakedValue, so a decrypted value never
 * passes through props, context-as-data, or any parent's render output. The value exists in
 * this component and nowhere else.
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

  if (snapshot.status === 'ready') {
    return <span className={className}>{snapshot.value}</span>
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
