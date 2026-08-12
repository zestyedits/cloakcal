'use client'

import { useEffect, useState } from 'react'
import { fieldKey, type CloakSubjectType } from '@cloakcal/cloak-store'
import { useCloakStore } from './cloak-provider'

/**
 * Decrypt several names at once, as plain strings.
 *
 * `useCloakedValue` reads one field and `CloakedText` renders it, which is the right shape
 * almost everywhere — a decrypted value never passes through props. This exists for the one
 * place that cannot use it: an HTML `<option>` holds text, not elements, so the audience
 * picker cannot render a component per label.
 *
 * ---------------------------------------------------------------------------
 * THIS IS A CONSEQUENCE OF ADR 0004, NOT A WORKAROUND
 * ---------------------------------------------------------------------------
 *
 * Contact names are Cloaked, so the server cannot label the picker — it does not know who
 * "Sarah" is and must not. The names arrive as ciphertext and are opened here, in the
 * browser, exactly as event titles are. Anyone reading the server render sees opaque ids.
 *
 * The cost is honest and visible: before unlock, the picker shows "Contact 4f2a…" rather than
 * a name. That is what a privacy-first address book looks like from the server's side, and
 * papering over it with a plaintext column is what ADR 0004 refuses.
 *
 * A hook per id would be the obvious alternative and is not allowed — the count changes as
 * contacts load, and hooks cannot be called conditionally. One subscription per key, managed
 * in an effect, is the honest version.
 */
export function useCloakedLabels(
  subjectType: CloakSubjectType,
  ids: readonly string[],
  fieldName: string,
): Readonly<Record<string, string>> {
  const store = useCloakStore()
  const [labels, setLabels] = useState<Record<string, string>>({})

  // Joined rather than passed as an array: a fresh array literal every render would restart
  // every subscription on every render, which is a subtle way to make an unlock never settle.
  const key = ids.join(',')

  useEffect(() => {
    if (store === null) return
    const list = key === '' ? [] : key.split(',')

    const read = () => {
      const next: Record<string, string> = {}
      for (const id of list) {
        const snapshot = store.getSnapshot(fieldKey(subjectType, id, fieldName))
        if (snapshot.status === 'ready') next[id] = snapshot.value
      }
      // Replace wholesale only when something actually changed, so a store notification for
      // an unrelated field does not rerender every consumer of this hook.
      setLabels((current) => {
        const sameSize = Object.keys(current).length === Object.keys(next).length
        if (sameSize && list.every((id) => current[id] === next[id])) return current
        return next
      })
    }

    const unsubscribes = list.map((id) =>
      store.subscribe(fieldKey(subjectType, id, fieldName), read),
    )
    read()

    return () => {
      for (const off of unsubscribes) off()
    }
  }, [store, key, subjectType, fieldName])

  return labels
}
