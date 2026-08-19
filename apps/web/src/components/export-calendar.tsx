'use client'

import { useState } from 'react'
import { toIcs, type IcsEvent } from '@cloakcal/domain'
import { createCloakStore, fieldKey, type EncryptedFieldRecord } from '@cloakcal/cloak-store'
import { getDevRootKey, isDevUnlockEnabled } from '@/lib/dev-key'
import { resumeSession } from '@/lib/cloak-session'
import { fromPgBytea } from '@/lib/pg-bytes'
import { Button } from './ui/button'
import styles from './export-calendar.module.css'

/**
 * "Export my calendar", and the reason it is a client component.
 *
 * The file contains decrypted titles, locations and notes. The server cannot read those and
 * must never be able to (rule 1, rule 2), so it cannot build the file — it serves sealed
 * bytes from `/api/export` and everything below happens in the browser, under a key that
 * never leaves it. That is the privacy policy's claim made mechanical:
 *
 *   "assembled in your browser from your own decrypted content, so the file will hold things
 *    our servers have never seen"
 *
 * TWO THINGS MUST NEVER CHANGE HERE.
 *
 * 1. **The plaintext never goes back out.** No fetch, no log, no analytics event, no error
 *    report carries a decrypted value. `e2e/leak.spec.ts` asserts no request body or URL
 *    holds exported content, and the Blob is built and revoked without touching the network.
 * 2. **It stays `'use client'`.** This module imports `@cloakcal/cloak-store`, which
 *    `server-boundary.leak.test.ts` forbids from any module without the directive. Dropping
 *    it fails the build rather than quietly moving decryption to the server.
 *
 * A LOCKED ACCOUNT EXPORTS NOTHING, LOUDLY. Without a key the ciphertext is present and
 * unreadable, and writing a file of untitled events would look exactly like data loss. It
 * refuses and says why instead.
 *
 * WHY THIS OWNS ITS STORE INSTEAD OF READING THE SHARED ONE. Settings IS inside
 * CloakProvider, so `useCloakStore()` would work — the reason is not availability, it is
 * blast radius. That store is ingested from a synthesised page holding calendar and contact
 * names; pushing every event in the account through it would leave the user's entire
 * decrypted history resident in shared state for the lifetime of the page, to serve one
 * click. A private store scoped to the operation decrypts what it needs and drops it in a
 * `finally`, so the plaintext is unreferenced by the time the download starts.
 *
 * The unlock path is deliberately the same one CloakProvider uses — dev key under the
 * fixture, resumed session otherwise — so there is never a second answer to "is this account
 * open". And a locked user is not stranded: the provider's own UnlockPanel is already on this
 * page for the calendar names, so the state below is a fallback rather than the only door.
 */

interface ExportSeriesJson {
  readonly eventId: string
  readonly dtstartLocal: string
  readonly durationMinutes: number
  readonly timezone: string
  readonly rrule: string | null
  readonly allDay: boolean
  readonly busy: 'busy' | 'free' | 'tentative'
  readonly fields: readonly {
    readonly fieldName: string
    readonly ciphertext: string
    readonly nonce: string
    readonly alg: string
    readonly keyVersion: number
  }[]
  readonly exdates: readonly string[]
}

interface ExportBundleJson {
  readonly series: readonly ExportSeriesJson[]
  readonly timezone: string
}

/** `2026-05-19T12:00:00.000Z` → `20260519T120000Z`. */
const stampNow = (): string => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

const fileName = (): string => `cloakcal-${new Date().toISOString().slice(0, 10)}.ics`

/** Not an error the user caused, so it gets its own state rather than an error message. */
class LockedError extends Error {}

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working' }
  | { readonly kind: 'locked' }
  | { readonly kind: 'done'; readonly count: number }
  | { readonly kind: 'error'; readonly message: string }

export function ExportCalendar(): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: 'idle' })

  const run = async () => {
    setState({ kind: 'working' })

    // Created here rather than at module scope: the constructor throws off-browser, which is
    // the behaviour we want if this ever renders during SSR by mistake.
    const store = createCloakStore()

    try {
      if (isDevUnlockEnabled()) {
        await store.unlock(getDevRootKey())
      } else {
        const session = await resumeSession().catch(() => null)
        if (session === null) throw new LockedError()
        await store.unlock(session.sessionKey)
      }

      const response = await fetch('/api/export', { headers: { Accept: 'application/json' } })
      if (!response.ok) {
        // 401 is the ordinary case here — the session expired while the page stayed open.
        // Middleware answers JSON for /api/*, so this is a status check and not a parse error.
        throw new Error(
          response.status === 401
            ? 'Your session expired. Sign in again and retry.'
            : 'We could not read your calendar. Nothing was written.',
        )
      }

      const bundle = (await response.json()) as ExportBundleJson

      // Ingest every sealed field first, then read them all back. Doing it in one pass means
      // the store decrypts once and this component never holds a key itself.
      const records: EncryptedFieldRecord[] = bundle.series.flatMap((series) =>
        series.fields.map((field) => ({
          subjectType: 'event' as const,
          subjectId: series.eventId,
          fieldName: field.fieldName,
          // Both bytea spellings, and a loud throw on anything else. A homegrown hex parser
          // that assumed bare hex is why contact names silently never decrypted for months.
          ciphertext: fromPgBytea(field.ciphertext),
          nonce: fromPgBytea(field.nonce),
          alg: field.alg,
          keyVersion: field.keyVersion,
        })),
      )
      await store.ingest(records)

      const read = (eventId: string, field: string): string | undefined => {
        const snapshot = store.getSnapshot(fieldKey('event', eventId, field))
        return snapshot.status === 'ready' && snapshot.value !== '' ? snapshot.value : undefined
      }

      const stamp = stampNow()
      const events: IcsEvent[] = bundle.series.map((series) => ({
        // Stable across exports, so re-importing updates an event rather than duplicating it.
        // The domain is ours; the id is already opaque.
        uid: `${series.eventId}@cloakcal.com`,
        series: {
          dtstartLocal: series.dtstartLocal,
          durationMinutes: series.durationMinutes,
          timezone: series.timezone,
          rrule: series.rrule,
        },
        allDay: series.allDay,
        busy: series.busy,
        summary: read(series.eventId, 'title'),
        location: read(series.eventId, 'location'),
        description: read(series.eventId, 'notes'),
        exdates: series.exdates,
      }))

      const ics = toIcs({ events, stamp })

      // Same shape as the recovery kit download, which already proves this path works here.
      const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = url
      link.download = fileName()
      link.click()
      URL.revokeObjectURL(url)

      setState({ kind: 'done', count: events.length })
    } catch (error) {
      if (error instanceof LockedError) {
        setState({ kind: 'locked' })
        return
      }
      // The message is ours, never the thrown one: a decryption or network error can carry
      // detail that has no business in front of a user, and this repo has been bitten by
      // forwarding a library's error text before.
      setState({
        kind: 'error',
        message:
          error instanceof Error && error.message.startsWith('Your session')
            ? error.message
            : 'We could not build the file. Nothing left your browser.',
      })
    } finally {
      // Drops the key and every decrypted value. Honest limit, same as ADR 0002: this
      // releases references rather than wiping memory, because JavaScript strings are
      // immutable. It still means nothing here outlives the click.
      store.lock()
    }
  }

  return (
    <div className={styles.export}>
      <Button variant="outline" onClick={run} disabled={state.kind === 'working'}>
        {state.kind === 'working' ? 'Building the file…' : 'Export as .ics'}
      </Button>

      {/* aria-live so the outcome reaches a screen reader: the visible result of this control
          is a file appearing in the downloads tray, which is not in the page at all. */}
      <p className={styles.note} aria-live="polite">
        {state.kind === 'locked'
          ? 'Your calendar is locked, so there is nothing readable to write. Open it, then export.'
          : state.kind === 'done'
            ? `Exported ${state.count} ${state.count === 1 ? 'event' : 'events'}. The file was built here and never sent anywhere.`
            : state.kind === 'error'
              ? state.message
              : 'A standard .ics file, built in this browser. Repeating events keep their rule rather than being flattened into copies.'}
      </p>
    </div>
  )
}
