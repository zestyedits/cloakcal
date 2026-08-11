'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Temporal } from '@js-temporal/polyfill'
import { useCloakStore } from './cloak-provider'
import { supabaseBrowser } from '@/lib/supabase/client'
import styles from './new-event.module.css'

/**
 * Create an event.
 *
 * THE ORDER HERE IS THE POINT. Content is sealed by the CloakStore *before* anything is
 * sent, and what crosses the wire is ciphertext plus times. There is no code path in this
 * component that hands a title to the server, and there is nowhere on the server to put one
 * — `events` has no title column, and never will.
 *
 * ATOMICITY. One RPC, `create_cloaked_event`, writes the event and its fields in a single
 * transaction as the signed-in user (SECURITY INVOKER, so RLS still applies). Two PostgREST
 * calls could not be one transaction, and a failure between them would leave an event with
 * no title — a row that renders as "Private event" forever and looks exactly like a
 * decryption failure.
 *
 * PROGRESSIVE DISCLOSURE. Title, day, time. Everything else is behind "Add details",
 * because the common case is a thing at a time and asking for eight fields to record it is
 * how calendars become chores.
 */

const DURATIONS = [15, 30, 45, 60, 90, 120] as const

const REPEATS = [
  { value: '', label: 'Does not repeat' },
  { value: 'FREQ=DAILY', label: 'Daily' },
  { value: 'FREQ=WEEKLY', label: 'Weekly' },
  { value: 'FREQ=MONTHLY', label: 'Monthly' },
] as const

interface Target {
  readonly workspaceId: string
  readonly calendarId: string
}

export function NewEvent({ timezone, defaultDate }: { timezone: string; defaultDate: string }) {
  const store = useCloakStore()
  const router = useRouter()

  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState<Target | null>(null)
  const [title, setTitle] = useState('')
  const [date, setDate] = useState(defaultDate)
  const [time, setTime] = useState('09:00')
  const [duration, setDuration] = useState<number>(30)
  const [repeat, setRepeat] = useState('')
  const [location, setLocation] = useState('')
  const [notes, setNotes] = useState('')
  const [detailed, setDetailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Resolved here rather than passed down from the server page, so the redacted payload
  // never has to carry a workspace id it would then be shipping to every audience. RLS
  // restricts this to the caller's own rows.
  useEffect(() => {
    if (!open || target !== null) return

    void (async () => {
      const supabase = supabaseBrowser()
      const { data: workspace } = await supabase
        .from('workspaces')
        .select('id')
        .eq('lifecycle', 'active')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle<{ id: string }>()
      if (workspace === null) return

      const { data: calendar } = await supabase
        .from('calendars')
        .select('id')
        .eq('workspace_id', workspace.id)
        .eq('lifecycle', 'active')
        .order('is_default', { ascending: false })
        .limit(1)
        .maybeSingle<{ id: string }>()
      if (calendar === null) return

      setTarget({ workspaceId: workspace.id, calendarId: calendar.id })
    })()
  }, [open, target])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)

    if (store === null || !store.isUnlocked) {
      setError('Your calendar is locked. Unlock it before adding an event.')
      return
    }
    if (target === null) {
      setError('No calendar found for this account yet.')
      return
    }

    setBusy(true)
    try {
      // Generated here so the fields can be sealed against the event's real id before
      // anything is written. The AAD binds ciphertext to that id, so it has to exist first.
      const eventId = globalThis.crypto.randomUUID()

      const local = Temporal.PlainDateTime.from(`${date}T${time}:00`)
      const zoned = local.toZonedDateTime(timezone, { disambiguation: 'earlier' })
      const end = zoned.add({ minutes: duration })

      const content: Array<[string, string]> = [['title', title.trim()]]
      if (location.trim() !== '') content.push(['location', location.trim()])
      if (notes.trim() !== '') content.push(['notes', notes.trim()])

      const fields = await Promise.all(
        content.map(async ([fieldName, value]) => {
          const sealed = await store.seal('event', eventId, fieldName, value)
          return {
            field_name: fieldName,
            ciphertext: toHex(sealed.ciphertext),
            nonce: toHex(sealed.nonce),
            alg: sealed.alg,
            key_version: sealed.keyVersion,
          }
        }),
      )

      const { error: rpcError } = await supabaseBrowser().rpc('create_cloaked_event', {
        p_event_id: eventId,
        p_workspace_id: target.workspaceId,
        p_calendar_id: target.calendarId,
        p_timezone: timezone,
        p_start_utc: zoned.toInstant().toString(),
        p_end_utc: end.toInstant().toString(),
        // The local wall clock is authoritative for a series: "09:00 every Tuesday" must
        // stay 09:00 after a DST shift, and only the local anchor preserves that (ADR 0001).
        p_dtstart_local: local.toString(),
        p_rrule: repeat === '' ? null : repeat,
        p_fields: fields,
      })
      if (rpcError !== null) throw rpcError

      setOpen(false)
      setTitle('')
      setLocation('')
      setNotes('')
      setDetailed(false)
      router.refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const locked = store === null || !store.isUnlocked

  if (!open) {
    return (
      <button
        type="button"
        className={styles.fab}
        disabled={locked}
        title={locked ? 'Unlock your calendar first' : 'New event'}
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true">+</span>
        <span className={styles.fabLabel}>New event</span>
      </button>
    )
  }

  return (
    <div className={styles.sheetScrim} role="dialog" aria-modal="true" aria-labelledby="new-event-title">
      <form className={styles.sheet} onSubmit={submit}>
        <h2 id="new-event-title" className={styles.sheetTitle}>
          New event
        </h2>

        {error !== null && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        <div className={styles.field}>
          <label className={styles.label} htmlFor="event-title">
            What is it
          </label>
          <input
            id="event-title"
            className={styles.input}
            required
            autoFocus
            maxLength={200}
            disabled={busy}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <p className={styles.hint}>Encrypted on this device before it is saved.</p>
        </div>

        <div className={styles.row}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="event-date">
              Day
            </label>
            <input
              id="event-date"
              className={styles.input}
              type="date"
              required
              disabled={busy}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="event-time">
              Starts
            </label>
            <input
              id="event-time"
              className={styles.input}
              type="time"
              required
              disabled={busy}
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </div>
        </div>

        <div className={styles.row}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="event-duration">
              For
            </label>
            <select
              id="event-duration"
              className={styles.input}
              disabled={busy}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
            >
              {DURATIONS.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes < 60 ? `${minutes} min` : `${minutes / 60} hr`}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="event-repeat">
              Repeats
            </label>
            <select
              id="event-repeat"
              className={styles.input}
              disabled={busy}
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
            >
              {REPEATS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {detailed ? (
          <>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="event-location">
                Where
              </label>
              <input
                id="event-location"
                className={styles.input}
                disabled={busy}
                value={location}
                onChange={(e) => setLocation(e.target.value)}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="event-notes">
                Notes
              </label>
              <textarea
                id="event-notes"
                className={styles.textarea}
                disabled={busy}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </>
        ) : (
          <button type="button" className={styles.disclose} onClick={() => setDetailed(true)}>
            Add where and notes
          </button>
        )}

        <div className={styles.actions}>
          <button type="button" className={styles.cancel} disabled={busy} onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button type="submit" className={styles.save} disabled={busy}>
            {busy ? 'Encrypting and saving' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  )
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}
