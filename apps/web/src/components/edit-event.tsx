'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Temporal } from '@js-temporal/polyfill'
import { useCloakStore } from './cloak-provider'
import { useCloakedValue } from './use-cloaked-value'
import { EventSheet } from './event-sheet'
import { EventFields, type EventFieldValues } from './event-fields'
import { sealFields } from '@/lib/cloaked-fields'
import { planFieldChanges, isNoop, type EditableField } from '@/lib/field-changes'
import { rpcErrorMessage, isVersionConflict } from '@/lib/rpc-error'
import { supabaseBrowser } from '@/lib/supabase/client'
import styles from './edit-event.module.css'

/**
 * Edit an event.
 *
 * WHOLE EVENT. Content on anything; day, time and duration on a non-recurring event. A
 * recurring event changes every occurrence, and its timing controls are not rendered at all
 * — see below. "Just this one" and "this and future" are series splits and come later.
 *
 * NOTHING LEAVES UNSEALED. Same order as creating: seal first, then one RPC carrying
 * ciphertext and times. The difference is that only CHANGED fields are sent. Editing keeps
 * the same event id, so the AAD is unchanged and untouched rows stay valid — re-sealing them
 * would churn nonces and could clobber a concurrent edit to a field this user never opened.
 *
 * SEEDED ONCE, NEVER RE-SEEDED. The form takes its initial values from the store on first
 * render and then stops listening. A router.refresh() while the sheet is open tears the
 * store down and rebuilds it, so the snapshots transiently go missing; re-seeding would blank
 * whatever the user had typed. The mount is keyed on the event so switching rows still gets
 * fresh values.
 */

const CONTENT_FIELDS = ['title', 'location', 'notes'] as const

export function EditEvent({
  eventId,
  version,
  recurring,
  timezone,
  /** This occurrence's start and end, as zoned ISO strings from the server render. */
  start,
  end,
  onClose,
}: {
  eventId: string
  version: number
  recurring: boolean
  timezone: string
  start: string
  end: string
  onClose: () => void
}) {
  const store = useCloakStore()
  const router = useRouter()

  const title = useCloakedValue('event', eventId, 'title')
  const location = useCloakedValue('event', eventId, 'location')
  const notes = useCloakedValue('event', eventId, 'notes')

  // Lazy initialiser: read once, on mount, and never again. See the note above.
  const [initial] = useState(() => ({
    title: title.status === 'ready' ? title.value : '',
    location: location.status === 'ready' ? location.value : '',
    notes: notes.status === 'ready' ? notes.value : '',
    ...initialTiming(start, end),
  }))
  const [values, setValues] = useState<EventFieldValues>(initial)
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [detailed, setDetailed] = useState(
    () => initial.location !== '' || initial.notes !== '' || location.status === 'error' || notes.status === 'error',
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflicted, setConflicted] = useState(false)

  const snapshots = { title, location, notes }
  const editable: EditableField[] = CONTENT_FIELDS.map((name) => ({
    name,
    snapshot: snapshots[name],
    value: values[name],
    touched: touched[name] === true,
  }))
  const changes = planFieldChanges(editable)

  // Timing is only editable on a non-recurring event, so a recurring one can never report a
  // timing change however the form is manipulated.
  const timingChanged =
    !recurring &&
    (values.date !== initial.date ||
      values.time !== initial.time ||
      values.duration !== initial.duration)

  const nothingToSave = isNoop(changes, timingChanged)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)

    if (store === null || !store.isUnlocked) {
      setError('Your calendar is locked. Unlock it before editing.')
      return
    }

    setBusy(true)
    try {
      const fields = await sealFields(store, eventId, changes.seal)

      let dtstartLocal: string | null = null
      let startUtc: string | null = null
      let endUtc: string | null = null

      if (timingChanged) {
        // Resolved here, with Temporal, exactly as the create sheet does. Wall-clock to
        // instant happens in ONE place across the app; if the server recomputed it with
        // `at time zone`, the two DST policies would disagree twice a year.
        const local = Temporal.PlainDateTime.from(`${values.date}T${values.time}:00`)
        const zoned = local.toZonedDateTime(timezone, { disambiguation: 'earlier' })
        dtstartLocal = local.toString()
        startUtc = zoned.toInstant().toString()
        endUtc = zoned.add({ minutes: values.duration }).toInstant().toString()
      }

      const { error: rpcError } = await supabaseBrowser().rpc('update_cloaked_event', {
        p_event_id: eventId,
        p_expected_version: version,
        p_dtstart_local: dtstartLocal,
        p_start_utc: startUtc,
        p_end_utc: endUtc,
        p_fields: fields,
        p_clear_fields: changes.clear,
      })
      if (rpcError !== null) throw rpcError

      onClose()
      router.refresh()
    } catch (caught) {
      // The sheet STAYS OPEN on failure, unlike the delete confirm. Delete can tell you to
      // reload because you have typed nothing; an edit that says "reload the page" throws
      // away work you just did.
      setError(rpcErrorMessage(caught))
      setConflicted(isVersionConflict(caught))
      setBusy(false)
    }
  }

  const unreadable = new Set(changes.skippedUnreadable)

  return (
    <EventSheet
      title="Edit event"
      error={error}
      busy={busy}
      submitLabel={busy ? 'Encrypting and saving' : 'Save'}
      submitDisabled={nothingToSave}
      cancelLabel="Cancel"
      onSubmit={submit}
      onClose={onClose}
    >
      {conflicted && (
        <button
          type="button"
          className={styles.refresh}
          onClick={() => {
            // Picks up the new version through the prop without unmounting the sheet: the
            // mount key is the event, which has not changed. Seeding-once is what makes this
            // safe — the store rebuild underneath does not touch what has been typed.
            setConflicted(false)
            setError(null)
            router.refresh()
          }}
        >
          Refresh and keep my changes
        </button>
      )}

      <EventFields
        values={values}
        onChange={(patch) => {
          setValues((v) => ({ ...v, ...patch }))
          setTouched((t) => ({ ...t, ...Object.fromEntries(Object.keys(patch).map((k) => [k, true])) }))
        }}
        disabled={busy}
        showWhen={!recurring}
        extraDurations={[initial.duration]}
        detailed={detailed}
        onDisclose={() => setDetailed(true)}
        titleHint={
          unreadable.has('title')
            ? undefined
            : 'Encrypted on this device before it is saved.'
        }
      />

      {/* Stated, not disabled. A greyed-out date picker reads as broken; a sentence reads as
          unbuilt, which is the truth. */}
      {recurring && (
        <p className={styles.note}>
          This event repeats. Changing the title, location or notes updates every occurrence.
          Changing <em>when</em> it happens arrives with the series split.
        </p>
      )}

      {unreadable.size > 0 && (
        <p className={styles.warning} role="status">
          {unreadable.size === 1
            ? `Your ${[...unreadable][0]} could not be decrypted on this device.`
            : `Some fields could not be decrypted on this device: ${[...unreadable].join(', ')}.`}{' '}
          They are shown blank and will be left exactly as they are. Type in one to replace it.
        </p>
      )}
    </EventSheet>
  )
}

/**
 * Pull the form's day/time/duration out of the occurrence the row was rendered from.
 *
 * `start` and `end` are zoned ISO strings, so the duration is computed between two ZONED
 * instants — which is what makes it correct across a DST boundary. Never `new Date()` on a
 * local wall-clock string; that reintroduces the host timezone ADR 0001 exists to remove.
 */
function initialTiming(start: string, end: string): Pick<EventFieldValues, 'date' | 'time' | 'duration'> {
  const from = Temporal.ZonedDateTime.from(start)
  const to = Temporal.ZonedDateTime.from(end)
  return {
    date: from.toPlainDate().toString(),
    time: from.toPlainTime().toString().slice(0, 5),
    duration: Math.max(1, Math.round(to.since(from, { largestUnit: 'minute' }).total({ unit: 'minute' }))),
  }
}
