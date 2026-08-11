'use client'

import { useSyncExternalStore } from 'react'
import { fieldKey, type CloakSubjectType, type FieldSnapshot } from '@cloakcal/cloak-store'
import { useCloakStore } from './cloak-provider'

/**
 * Read one Cloaked field.
 *
 * Extracted from CloakedText so that rendering a value and pre-filling a form with it use
 * the SAME subscription, rather than two hand-rolled ones that could drift on the state
 * nobody thinks about — `error`.
 *
 * `getServerSnapshot` deliberately returns the locked state: during SSR there is no store
 * and no key, and the server-rendered HTML must contain a placeholder rather than content.
 * That is what makes the initial-HTML leak test meaningful.
 */
export function useCloakedValue(
  subjectType: CloakSubjectType,
  subjectId: string,
  fieldName: string,
): FieldSnapshot {
  const store = useCloakStore()
  const key = fieldKey(subjectType, subjectId, fieldName)

  return useSyncExternalStore(
    (listener) => store?.subscribe(key, listener) ?? (() => {}),
    () => store?.getSnapshot(key) ?? LOCKED,
    () => LOCKED,
  )
}

const LOCKED: FieldSnapshot = { status: 'locked' }
