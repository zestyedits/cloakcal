'use client'

import { useSyncExternalStore } from 'react'
import { fieldKey, type CloakSubjectType } from '@cloakcal/cloak-store'
import { useCloakStore } from './cloak-provider'

/**
 * Renders one Cloaked field.
 *
 * Subscribes to exactly one field key through useSyncExternalStore, so a decrypted value
 * never passes through props, context-as-data, or any parent's render output. The value
 * exists in this component and nowhere else.
 *
 * `getServerSnapshot` deliberately returns the locked state: during SSR there is no store
 * and no key, and the server-rendered HTML must contain the placeholder rather than
 * content. That is what makes the initial-HTML leak test meaningful.
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
  const store = useCloakStore()
  const key = fieldKey(subjectType, subjectId, fieldName)

  const snapshot = useSyncExternalStore(
    (listener) => store?.subscribe(key, listener) ?? (() => {}),
    () => store?.getSnapshot(key) ?? LOCKED,
    () => LOCKED,
  )

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

const LOCKED = { status: 'locked' } as const
