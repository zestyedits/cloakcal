'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { createCloakStore, type CloakStore, type EncryptedFieldRecord } from '@cloakcal/cloak-store'
import { getDevRootKey, isDevUnlockEnabled } from '@/lib/dev-key'
import type { RedactedPage } from '@/server/audience'

/**
 * The hydration boundary.
 *
 * The server hands down ciphertext; this is the first and only place it becomes readable,
 * and it only ever runs in the browser. The store itself is never placed in React state or
 * context *as data* — it is an external store that components subscribe to, so a decrypted
 * value never becomes a prop that could be serialized into an RSC payload.
 */

const StoreContext = createContext<CloakStore | null>(null)

const toBytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16))

/** Flatten a page's ciphertext into the records the store ingests. */
function toRecords(page: RedactedPage): EncryptedFieldRecord[] {
  const records: EncryptedFieldRecord[] = []

  for (const calendar of page.calendars) {
    for (const field of calendar.fields) {
      records.push({
        subjectType: 'calendar',
        subjectId: calendar.id,
        fieldName: field.fieldName,
        ciphertext: toBytes(field.ciphertext),
        nonce: toBytes(field.nonce),
        alg: field.alg,
        keyVersion: field.keyVersion,
      })
    }
  }

  const seen = new Set<string>()
  for (const occurrence of page.occurrences) {
    // Occurrences of one series share the event's fields; ingest each event once.
    if (seen.has(occurrence.eventId)) continue
    seen.add(occurrence.eventId)

    for (const field of occurrence.fields) {
      records.push({
        subjectType: 'event',
        subjectId: occurrence.eventId,
        fieldName: field.fieldName,
        ciphertext: toBytes(field.ciphertext),
        nonce: toBytes(field.nonce),
        alg: field.alg,
        keyVersion: field.keyVersion,
      })
    }
  }

  return records
}

export function CloakProvider({ page, children }: { page: RedactedPage; children: ReactNode }) {
  // Created lazily inside an effect-free initializer that only runs client-side. The store
  // constructor throws off-browser, which is the behaviour we want if this ever renders
  // during SSR by mistake — but useState's initializer does run during SSR, so it is
  // deferred to the effect below instead.
  const [store, setStore] = useState<CloakStore | null>(null)

  useEffect(() => {
    const instance = createCloakStore()
    let cancelled = false

    void (async () => {
      if (isDevUnlockEnabled()) {
        await instance.unlock(getDevRootKey())
      }
      await instance.ingest(toRecords(page))
      if (!cancelled) setStore(instance)
    })()

    return () => {
      cancelled = true
      instance.lock()
    }
  }, [page])

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}

export function useCloakStore(): CloakStore | null {
  return useContext(StoreContext)
}
