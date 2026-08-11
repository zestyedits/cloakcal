'use client'

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { createCloakStore, type CloakStore, type EncryptedFieldRecord } from '@cloakcal/cloak-store'
import { getDevRootKey, isDevUnlockEnabled } from '@/lib/dev-key'
import { resumeSession } from '@/lib/cloak-session'
import type { RedactedPage } from '@/server/audience'
import { UnlockPanel } from './unlock-panel'

/**
 * The hydration boundary.
 *
 * The server hands down ciphertext; this is the first and only place it becomes readable,
 * and it only ever runs in the browser. The store is never placed in React state or context
 * *as data* — it is an external store components subscribe to, so a decrypted value never
 * becomes a prop that could be serialized into an RSC payload.
 *
 * THREE WAYS TO GET A KEY, in descending order of preference:
 *
 *   1. Resume — a non-extractable CryptoKey persisted in IndexedDB at the last unlock. No
 *      password, no Argon2id, no wait. This is the normal path on every reload.
 *   2. Unlock — the panel below, when there is a session but no stored key.
 *   3. Dev unlock — a published constant, refused in production builds, for the fixture.
 *
 * A missing key is not an error state. The calendar still renders: times, durations and
 * recurrence are Tier A and the server genuinely knows them (plan D1). What is missing is
 * the content, which is the honest picture of what CloakCal protects.
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

export function CloakProvider({
  page,
  email,
  children,
}: {
  page: RedactedPage
  /** Empty in tests and on the fixture path, where there is no signed-in user. */
  email?: string | undefined
  children: ReactNode
}) {
  const [store, setStore] = useState<CloakStore | null>(null)
  const [locked, setLocked] = useState(false)
  // Bumped by the unlock panel to re-run the effect once a key exists.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    // The store constructor throws off-browser, which is the behaviour we want if this ever
    // renders during SSR by mistake — so creation is deferred into the effect.
    const instance = createCloakStore()
    let cancelled = false

    void (async () => {
      let unlocked = false

      if (isDevUnlockEnabled()) {
        await instance.unlock(getDevRootKey())
        unlocked = true
      } else {
        const session = await resumeSession().catch(() => null)
        if (session !== null) {
          await instance.unlock(session.sessionKey)
          unlocked = true
        }
      }

      await instance.ingest(toRecords(page))
      if (cancelled) return

      setStore(instance)
      // Only prompt when there is something sealed to open. An empty calendar behind a
      // locked panel would be a wall in front of nothing.
      setLocked(!unlocked && page.occurrences.length + page.calendars.length > 0)
    })()

    return () => {
      cancelled = true
      instance.lock()
    }
  }, [page, attempt])

  const onUnlocked = useCallback(() => {
    setLocked(false)
    setAttempt((n) => n + 1)
  }, [])

  return (
    <StoreContext.Provider value={store}>
      {children}
      {locked && email !== undefined && email.length > 0 && (
        <UnlockPanel email={email} onUnlocked={onUnlocked} />
      )}
    </StoreContext.Provider>
  )
}

export function useCloakStore(): CloakStore | null {
  return useContext(StoreContext)
}
