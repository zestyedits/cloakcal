'use client'

import { useCallback, useEffect, useState } from 'react'
import { createCloakStore, fieldKey, type EncryptedFieldRecord } from '@cloakcal/cloak-store'
import { getDevRootKey, isDevUnlockEnabled } from '@/lib/dev-key'
import { resumeSession } from '@/lib/cloak-session'
import { fromPgBytea } from '@/lib/pg-bytes'
import { supabaseBrowser } from '@/lib/supabase/client'
import { rpcErrorMessage } from '@/lib/rpc-error'
import { wallTimeLabel } from '@/lib/wall-time'
import { savedDateLabel } from '@/lib/saved-event'
import { Button } from '../ui/button'
import { InlineError } from '../ui/inline-error'
import styles from './settings.module.css'

/**
 * Trash — the durable half of undo.
 *
 * The strip on the calendar covers the moment. This covers Thursday: a user who navigated
 * away, reloaded, or simply came back later has no strip left, and until this existed the
 * only route to a reversible deletion was one that vanished on the first page load.
 *
 * ---------------------------------------------------------------------------
 * "TRASH", NEVER "RECENTLY DELETED"
 * ---------------------------------------------------------------------------
 *
 * There is no cron in this product and nothing expires. A heading containing "Recently"
 * implies a retention window, and implying one that does not exist is the same small,
 * plausible, untrue claim as the export sentence that sat in legal.ts for months. The honest
 * name is also the shorter one. `legal-claims.server.test.ts` pins the pairing between this
 * control and the sentence in the privacy policy that describes it.
 *
 * ---------------------------------------------------------------------------
 * TWO KINDS OF DELETED THING, AND THEY ARE NOT THE SAME
 * ---------------------------------------------------------------------------
 *
 * A TRASHED EVENT is a row: `lifecycle = 'trashed'`, restorable, and permanently removable —
 * purging it destroys ciphertext, which is the only erasure this product performs.
 *
 * A CANCELLED OCCURRENCE is a subtraction recorded against a recurrence rule. Its series
 * still owns all the ciphertext, because the surviving occurrences need it. So it offers
 * RESTORE ONLY: there is no separate content to erase, and deleting the exception row IS the
 * restore. A "delete permanently" beside it would be a control whose two options do the same
 * thing in opposite directions, so the row says why instead of leaving the gap unexplained.
 *
 * A cancelled occurrence whose series is ITSELF trashed is not listed: it is subsumed by the
 * series entry, and showing both would offer two restores for one act.
 *
 * ---------------------------------------------------------------------------
 * TWO QUERIES, NOT AN EMBED
 * ---------------------------------------------------------------------------
 *
 * The parent-series lifecycle could be had with a PostgREST embed, which would mean naming a
 * foreign-key relationship in a string. That is exactly the class of thing that works against
 * one schema and 400s against another, with nothing here able to see it — the fixture has no
 * session, so none of this code runs in any test in the repo. Two plain selects and a filter
 * in TypeScript cost one round trip and cannot be wrong about a constraint name.
 *
 * ---------------------------------------------------------------------------
 * A PRIVATE STORE, AND AN HONEST DEGRADATION WHEN LOCKED
 * ---------------------------------------------------------------------------
 *
 * Titles open in a store scoped to this component, exactly as `export-calendar.tsx` does and
 * for the same reason: blast radius, not availability. Pushing a user's whole deleted history
 * through the shared store would leave it resident in page state to serve one glance.
 *
 * When there is no key the rows still render — a date, a time, a duration are Tier A and the
 * server holds them in the clear anyway — and the title shows the same placeholder every other
 * sealed value in the product shows. Restore needs no key at all (0031 touches no ciphertext),
 * so a locked user can still recover an event they cannot yet read.
 */

interface TrashedEvent {
  readonly kind: 'event'
  readonly id: string
  readonly version: number
  readonly dtstartLocal: string | null
  readonly trashedAt: string | null
}

interface CancelledOccurrence {
  readonly kind: 'occurrence'
  readonly id: string
  readonly seriesId: string
  readonly occurrenceLocal: string
}

type TrashRow = TrashedEvent | CancelledOccurrence

/**
 * PostgREST's spelling of a `timestamp without time zone`, turned into the app's.
 *
 * It returns `2026-05-26 09:00:00` with a SPACE, and everything downstream wants the `T`.
 * Two failures, both silent then loud, and this component had both: `wallTimeLabel` tests
 * `local.includes('T')` and returns the all-day fallback without one, so every row showed a
 * date and no time; and `private.canonical_local` regex-validates for the `T` before it
 * casts, so `uncancel_occurrence` raised `noncanonical_time` and the user was told
 * "Something went wrong with the date on this event. Nothing was saved." while trying to
 * RESTORE something. The occurrence half of this page did not work at all.
 *
 * Not a guess: `server/events.ts` and `server/export.ts` each do exactly this replace on
 * `occurrence_local`, which is two independent votes on what the wire actually carries.
 * Nothing here could have caught it, because the fixture has no session and never issues
 * one of these queries.
 */
const fromPgLocal = (value: string): string => value.replace(' ', 'T')

/** The date and time of a deleted thing, from its local wall string. Never an instant. */
function whenOf(local: string | null): string {
  if (local === null || local === '') return 'Date unknown'
  const time = wallTimeLabel(local, '')
  const date = savedDateLabel(local.slice(0, 10))
  return time === '' ? date : `${date}, ${time}`
}

export function TrashSection({ demo }: { demo: boolean }) {
  const [rows, setRows] = useState<readonly TrashRow[] | null>(null)
  const [titles, setTitles] = useState<Readonly<Record<string, string>>>({})
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  /** Which row is confirming a permanent delete. One at a time, by construction. */
  const [purging, setPurging] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (demo) {
      setRows([])
      return
    }
    setError(null)
    try {
      const supabase = supabaseBrowser()

      const { data: trashed, error: trashedError } = await supabase
        .from('events')
        .select('id, version, dtstart_local, trashed_at')
        .eq('lifecycle', 'trashed')
        .order('trashed_at', { ascending: false })
        .returns<
          { id: string; version: number; dtstart_local: string | null; trashed_at: string | null }[]
        >()
      if (trashedError !== null) throw trashedError

      const { data: exceptions, error: exceptionError } = await supabase
        .from('recurrence_exceptions')
        .select('id, series_id, occurrence_local')
        .eq('kind', 'cancelled')
        .returns<{ id: string; series_id: string; occurrence_local: string }[]>()
      if (exceptionError !== null) throw exceptionError

      // Only occurrences whose series is still on the calendar. A cancelled occurrence of a
      // trashed series is already represented by the series row above.
      const seriesIds = [...new Set((exceptions ?? []).map((row) => row.series_id))]
      const active = new Set<string>()
      if (seriesIds.length > 0) {
        const { data: series, error: seriesError } = await supabase
          .from('events')
          .select('id')
          .eq('lifecycle', 'active')
          .in('id', seriesIds)
          .returns<{ id: string }[]>()
        if (seriesError !== null) throw seriesError
        for (const row of series ?? []) active.add(row.id)
      }

      const events: TrashRow[] = (trashed ?? []).map((row) => ({
        kind: 'event',
        id: row.id,
        version: row.version,
        dtstartLocal: row.dtstart_local === null ? null : fromPgLocal(row.dtstart_local),
        trashedAt: row.trashed_at,
      }))
      const occurrences: TrashRow[] = (exceptions ?? []).flatMap((row) =>
        active.has(row.series_id)
          ? [
              {
                kind: 'occurrence' as const,
                id: row.id,
                seriesId: row.series_id,
                occurrenceLocal: fromPgLocal(row.occurrence_local),
              },
            ]
          : [],
      )

      setRows([...events, ...occurrences])

      // Titles, in a store that exists only for this read. A locked account simply gets no
      // titles, which the rows below render as the standard placeholder.
      const subjectIds = [
        ...events.map((row) => row.id),
        ...occurrences.map((row) => (row as CancelledOccurrence).seriesId),
      ]
      if (subjectIds.length > 0) {
        // Its own catch, and a DIFFERENT sentence: the list above is correct and useful
        // without a single title, so a failure to open them must not blank the page. What
        // it must not do either is stay silent, which would leave every row saying
        // "Private event" -- byte-identical to the locked-account degradation -- on the
        // screen where the user decides what to destroy.
        await openTitles(subjectIds, setTitles).catch(() => {
          setError(
            'These are your deleted events, but their titles could not be opened on this device. Unlock your calendar, or take care: the rows below are identified by time only.',
          )
        })
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setRows([])
    }
  }, [demo])

  useEffect(() => {
    void load()
  }, [load])

  // PromiseLike, not Promise: PostgREST's builder is a thenable that only becomes a real
  // promise when awaited, so typing this as Promise rejects every call site.
  const run = async (id: string, action: () => PromiseLike<{ error: unknown }>) => {
    setBusyId(id)
    setError(null)
    try {
      const { error: rpcError } = await action()
      if (rpcError !== null) throw rpcError
      setPurging(null)
      await load()
    } catch (caught) {
      const code = (caught as { code?: string } | null)?.code
      setError(
        code === 'PGRST202'
          ? 'This is not available on this deployment yet. Nothing changed.'
          : rpcErrorMessage(caught),
      )
    } finally {
      setBusyId(null)
    }
  }

  const titleOf = (subjectId: string) => titles[subjectId] ?? 'Private event'

  if (demo) {
    return (
      <p className={styles.sectionLede}>
        Demo. Deleted events would be listed here, with a way to put them back.
      </p>
    )
  }

  return (
    <>
      <p className={styles.sectionLede}>
        Deleting an event moves it here. Nothing leaves on a timer: it stays until you put it
        back or remove it permanently.
      </p>

      <InlineError>{error}</InlineError>

      {rows === null ? (
        <p className={styles.rowNote}>Loading.</p>
      ) : rows.length === 0 ? (
        <p className={styles.rowNote}>Nothing deleted.</p>
      ) : (
        <ul className={styles.plainList}>
          {rows.map((row) =>
            row.kind === 'event' ? (
              <li key={row.id} className={styles.row}>
                <span className={styles.rowLabel}>{titleOf(row.id)}</span>
                <span className={styles.rowMeta}>{whenOf(row.dtstartLocal)}</span>
                {purging === row.id ? (
                  <>
                    {/* The one irreversible action in the product, so it is spelled out
                        rather than confirmed by a second click on the same word. */}
                    <span className={styles.rowNote}>
                      Erase its encrypted content for good? This cannot be undone.
                    </span>
                    <Button variant="outline" size="sm" onClick={() => setPurging(null)}>
                      Keep
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      busy={busyId === row.id}
                      onClick={() =>
                        void run(row.id, () =>
                          supabaseBrowser().rpc('purge_cloaked_event', { p_event_id: row.id }),
                        )
                      }
                    >
                      Delete permanently
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      busy={busyId === row.id}
                      onClick={() =>
                        void run(row.id, () =>
                          supabaseBrowser().rpc('restore_cloaked_event', {
                            p_event_id: row.id,
                            // The version BEFORE the trash, which is what 0031 asks for. The
                            // row now carries version + 1, so this subtracts rather than the
                            // function adding — the arithmetic lives in exactly one place per
                            // direction and both name why.
                            p_deleted_from_version: row.version - 1,
                          }),
                        )
                      }
                    >
                      Restore
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setPurging(row.id)}>
                      Delete permanently
                    </Button>
                  </>
                )}
              </li>
            ) : (
              <li key={row.id} className={styles.row}>
                <span className={styles.rowLabel}>{titleOf(row.seriesId)}</span>
                <span className={styles.rowMeta}>
                  One occurrence, {whenOf(row.occurrenceLocal)}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  busy={busyId === row.id}
                  onClick={() =>
                    void run(row.id, () =>
                      supabaseBrowser().rpc('uncancel_occurrence', {
                        p_series_id: row.seriesId,
                        p_occurrence_local: row.occurrenceLocal,
                      }),
                    )
                  }
                >
                  Restore
                </Button>
                {/* NO PERMANENT DELETE HERE, and the row says so rather than leaving a
                    conspicuous gap. The series owns the content; this row is a subtraction,
                    and removing it is the restore. */}
                <span className={styles.rowNote}>
                  Its content belongs to the repeating event, so there is nothing separate to
                  remove.
                </span>
              </li>
            ),
          )}
        </ul>
      )}
    </>
  )
}

/**
 * Open the titles of a set of events in a store that lives only for this call.
 *
 * Same unlock ladder as CloakProvider and ExportCalendar — dev key under the fixture, resumed
 * session otherwise — so there is never a second answer to "is this account open". A locked
 * account throws before any ciphertext is fetched, which is not an error state here: the
 * caller keeps the empty map and every row renders the standard placeholder.
 */
async function openTitles(
  subjectIds: readonly string[],
  setTitles: (next: Readonly<Record<string, string>>) => void,
): Promise<void> {
  // Throws rather than returning quietly on a failed read: see the call site. A caught
  // error there becomes a visible sentence, because rows reading "Private event" because
  // the QUERY failed look exactly like rows reading it because the account is locked, and
  // this is the screen where the user chooses what to erase permanently.
  const store = createCloakStore()
  try {
    if (isDevUnlockEnabled()) {
      await store.unlock(getDevRootKey())
    } else {
      const session = await resumeSession().catch(() => null)
      if (session === null) return
      await store.unlock(session.sessionKey)
    }

    const { data, error: readError } = await supabaseBrowser()
      .from('cloaked_fields')
      .select('subject_id, field_name, ciphertext, nonce, alg, key_version')
      .eq('subject_type', 'event')
      .eq('field_name', 'title')
      .in('subject_id', [...new Set(subjectIds)])
      .returns<
        {
          subject_id: string
          field_name: string
          ciphertext: string
          nonce: string
          alg: string
          key_version: number
        }[]
      >()
    if (readError !== null) throw readError
    if (data === null) return

    const records: EncryptedFieldRecord[] = data.map((row) => ({
      subjectType: 'event' as const,
      subjectId: row.subject_id,
      fieldName: row.field_name,
      // Both bytea spellings, and a loud throw on anything else. A homegrown hex parser that
      // assumed bare hex is why contact names silently never decrypted for months.
      ciphertext: fromPgBytea(row.ciphertext),
      nonce: fromPgBytea(row.nonce),
      alg: row.alg,
      keyVersion: row.key_version,
    }))
    await store.ingest(records)

    const opened: Record<string, string> = {}
    for (const row of data) {
      const snapshot = store.getSnapshot(fieldKey('event', row.subject_id, 'title'))
      if (snapshot.status === 'ready' && snapshot.value !== '') opened[row.subject_id] = snapshot.value
    }
    setTitles(opened)
  } finally {
    // Always, on every path. The decrypted titles must not outlive the render that needed
    // them — the same `finally` ExportCalendar uses, for the same reason.
    store.lock()
  }
}
