'use client'

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import {
  createCloakStore,
  type CloakStore,
  type CloakSubjectType,
  type EncryptedFieldRecord,
} from '@cloakcal/cloak-store'
import { getDevRootKey, isDevUnlockEnabled } from '@/lib/dev-key'
import { fromPgBytea } from '@/lib/pg-bytes'
import { resumeSession } from '@/lib/cloak-session'
import type { CiphertextField } from '@/server/events'
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

// The shared bytea parser, NOT a local hex one. The local version this replaces assumed
// bare hex and silently produced garbage for PostgREST's `\x…` spelling: parseInt('\\x')
// is NaN, every byte misaligns, AES-GCM refuses the tag, and the only symptom is a label
// that never opens. events.ts strips the prefix server-side but visibility.ts ships it
// raw, so contact names arrived prefixed and NEVER decrypted on a real account — the
// 2026-08-12 ingest fix plumbed the fields through and this parser then threw them away.
// fromPgBytea handles both spellings and throws loudly on anything else.
const toBytes = (value: string): Uint8Array => fromPgBytea(value)

/**
 * Sealed fields that do not ride on the page's occurrences or calendars — contact and
 * group names, mostly.
 *
 * This prop exists because of a real defect: `loadWorkspaceVisibility` attached sealed
 * contact names to every audience option, `useCloakedLabels` subscribed to them — and
 * nothing ever INGESTED them, so on a real account the View As picker showed
 * `Contact 4f2a…` forever, even unlocked. The fixture audiences carry no nameField, so
 * every e2e run sailed past it. Ingestion and subscription must use the same store, and
 * this is the one door into it.
 */
export interface ExtraSealedField {
  readonly subjectType: CloakSubjectType
  readonly subjectId: string
  readonly field: CiphertextField
}

const toExtraRecords = (extra: readonly ExtraSealedField[]): EncryptedFieldRecord[] =>
  extra.map(({ subjectType, subjectId, field }) => ({
    subjectType,
    subjectId,
    fieldName: field.fieldName,
    ciphertext: toBytes(field.ciphertext),
    nonce: toBytes(field.nonce),
    alg: field.alg,
    keyVersion: field.keyVersion,
  }))

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

/**
 * THE DEFAULT, AS A MODULE CONSTANT, and that is load-bearing rather than tidy.
 *
 * `extraFields = []` as an inline default builds a NEW ARRAY ON EVERY RENDER, and this value
 * is in the unlock effect's dependency array. So a caller that simply omitted the prop got:
 * effect runs, `setStore` re-renders, fresh `[]`, effect runs again — an unbounded loop that
 * costs nothing visible. The page paints, frames stay at 16ms and `evaluate` answers, because
 * React keeps yielding; what it will not do is finish acknowledging an input event, so every
 * real click on the page hung and only a synthetic `el.click()` worked.
 *
 * It took a bisect down to an empty screen to find, because nothing looks wrong. The JSDoc
 * below has said "memoise in the caller" since this prop existed, and it was followed by four
 * of the five call sites; the fifth omitted the prop entirely, which reads like the one case
 * the instruction cannot be about. A stable default is what makes the instruction unnecessary
 * for the empty case instead of merely unwritten.
 */
const NO_EXTRA_FIELDS: readonly ExtraSealedField[] = Object.freeze([])

export function CloakProvider({
  page,
  email,
  extraFields = NO_EXTRA_FIELDS,
  children,
}: {
  page: RedactedPage
  /** Empty in tests and on the fixture path, where there is no signed-in user. */
  email?: string | undefined
  /**
   * Memoise in the caller: this participates in the effect's dependency array, so a fresh
   * array identity per render is an infinite effect loop. Omitting it is safe — the default
   * above is a single frozen instance.
   */
  extraFields?: readonly ExtraSealedField[]
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

      await instance.ingest([...toRecords(page), ...toExtraRecords(extraFields)])
      if (cancelled) return

      setStore(instance)
      // Only prompt when there is something sealed to open. An empty calendar behind a
      // locked panel would be a wall in front of nothing.
      setLocked(
        !unlocked && page.occurrences.length + page.calendars.length + extraFields.length > 0,
      )
    })()

    return () => {
      cancelled = true
      instance.lock()
    }
  }, [page, extraFields, attempt])

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
