'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Temporal } from '@js-temporal/polyfill'
import { useCloakStore } from './cloak-provider'
import { useCloakedValue } from './use-cloaked-value'
import { EventSheet } from './event-sheet'
import { EventFields, type EventFieldValues } from './event-fields'
import { sealFields } from '@/lib/cloaked-fields'
import { UnsafeSplitError, planSplit } from '@/lib/split-plan'
import { planFieldChanges, isNoop, type EditableField } from '@/lib/field-changes'
import { rpcErrorMessage, isVersionConflict } from '@/lib/rpc-error'
import { supabaseBrowser } from '@/lib/supabase/client'
import styles from './edit-event.module.css'

/**
 * Edit an event.
 *
 * SCOPE. A one-off event just saves. A repeating one asks which occurrences to change:
 * this one, this and everything after it, or all of them. The first two are SERIES SPLITS
 * and take a different RPC — see split-plan.ts for why the safety check for those lives on
 * this side of the wire.
 *
 * RE-SEALING IS NOT OPTIONAL ON A SPLIT. Both split scopes create a NEW event row, and the
 * AEAD binds ciphertext to the subject id, so every content field has to be re-sealed
 * against the new id — not just the ones the user edited. That is also why a split refuses
 * to run when any field is unreadable on this device: carrying content forward requires
 * being able to read it, and quietly dropping a field the user cannot see would be the
 * worst possible outcome of an edit.
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

type Scope = 'this' | 'this-and-future' | 'entire-series'

/**
 * The consequence of each choice, said plainly.
 *
 * Copy, not decoration: this is the sentence that stops somebody changing forty meetings
 * when they meant one. "Including ones that have already happened" is the part people are
 * surprised by, so it is stated rather than implied.
 */
const SCOPE_COPY: Record<Scope, { label: string; consequence: string }> = {
  this: {
    label: 'Only this event',
    consequence: 'Just this occurrence changes. The rest of the series stays as it is.',
  },
  'this-and-future': {
    label: 'This and all following',
    consequence: 'This occurrence and every one after it changes. Earlier ones stay as they are.',
  },
  'entire-series': {
    label: 'All events',
    consequence: 'Every occurrence changes, including ones that have already happened.',
  },
}

export function EditEvent({
  eventId,
  version,
  recurring,
  series,
  occurrenceLocal,
  timezone,
  /** This occurrence's start and end, as zoned ISO strings from the server render. */
  start,
  end,
  onClose,
}: {
  eventId: string
  version: number
  recurring: boolean
  /** The rule behind a repeating event. Null when it does not repeat. */
  series: { dtstartLocal: string; rrule: string; durationMinutes: number } | null
  /** This occurrence's original local wall time — the split point, never an instant. */
  occurrenceLocal: string
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
  // Least destructive first, and what every other calendar defaults to.
  const [scope, setScope] = useState<Scope>('this')

  const snapshots = { title, location, notes }
  const editable: EditableField[] = CONTENT_FIELDS.map((name) => ({
    name,
    snapshot: snapshots[name],
    value: values[name],
    touched: touched[name] === true,
  }))
  const changes = planFieldChanges(editable)

  // A repeating event can only be retimed under a SPLIT scope. Changing when every
  // occurrence happens would move the series anchor, stranding every recurrence_exceptions
  // row on the old wall time — the RPC refuses it outright, and the form does not offer it.
  const splitting = recurring && scope !== 'entire-series' && series !== null
  const canRetime = !recurring || splitting

  const timingChanged =
    canRetime &&
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

    if (splitting && changes.skippedUnreadable.length > 0) {
      // Refused rather than half-done. A split copies content to a brand-new row, and a
      // field this device cannot decrypt cannot be copied — it would silently vanish from
      // the occurrence the user just edited while still existing on the original.
      setError(
        `Some fields could not be decrypted on this device (${changes.skippedUnreadable.join(', ')}), ` +
          'so this occurrence cannot be separated from the series without losing them. ' +
          'Choose "All events", or unlock on the device that created them.',
      )
      return
    }

    setBusy(true)
    try {
      // Wall clock to instant happens in ONE place across the app. If the server recomputed
      // it with `at time zone`, the two DST policies would disagree twice a year.
      const resolved = timingChanged
        ? (() => {
            const local = Temporal.PlainDateTime.from(`${values.date}T${values.time}:00`)
            const zoned = local.toZonedDateTime(timezone, { disambiguation: 'earlier' })
            return {
              dtstartLocal: local.toString(),
              startUtc: zoned.toInstant().toString(),
              endUtc: zoned.add({ minutes: values.duration }).toInstant().toString(),
            }
          })()
        : null

      if (splitting && series !== null) {
        // A NEW row, so a NEW id, generated before sealing — the AAD binds content to it.
        const newEventId = globalThis.crypto.randomUUID()

        // Throws before anything is written if the split would add, lose or duplicate an
        // occurrence. This is gate 3a; the RPC's read-back check is 3b.
        const plan = planSplit({
          series: { ...series, timezone },
          occurrenceLocal,
          scope,
          newEventId,
          ...(resolved === null ? {} : { timing: resolved }),
        })

        // EVERY field, not just the changed ones: the new id means none of the existing
        // ciphertext can be reused.
        const carried: Array<[string, string]> = CONTENT_FIELDS.filter(
          (name) => values[name].trim() !== '',
        ).map((name) => [name, values[name].trim()])

        const { error: splitError } = await supabaseBrowser().rpc('split_cloaked_event', {
          p_series_id: eventId,
          p_expected_version: version,
          p_occurrence_local: occurrenceLocal,
          p_scope: plan.scope,
          p_new_event_id: plan.newEventId,
          p_truncate_rrule: plan.truncateRrule,
          p_new_dtstart_local: plan.newDtstartLocal,
          p_new_start_utc: plan.newStartUtc,
          p_new_end_utc: plan.newEndUtc,
          p_new_rrule: plan.newRrule,
          p_fields: await sealFields(store, 'event', newEventId, carried),
        })
        if (splitError !== null) throw splitError
      } else {
        const { error: rpcError } = await supabaseBrowser().rpc('update_cloaked_event', {
          p_event_id: eventId,
          p_expected_version: version,
          p_dtstart_local: resolved?.dtstartLocal ?? null,
          p_start_utc: resolved?.startUtc ?? null,
          p_end_utc: resolved?.endUtc ?? null,
          p_fields: await sealFields(store, 'event', eventId, changes.seal),
          p_clear_fields: changes.clear,
        })
        if (rpcError !== null) throw rpcError
      }

      onClose()
      router.refresh()
    } catch (caught) {
      // The sheet STAYS OPEN on failure, unlike the delete confirm. Delete can tell you to
      // reload because you have typed nothing; an edit that says "reload the page" throws
      // away work you just did.
      //
      // An unsafe split already carries a plain-language explanation of what it would have
      // done to the calendar, which is more useful than any generic mapping.
      setError(caught instanceof UnsafeSplitError ? caught.message : rpcErrorMessage(caught))
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
        showWhen={canRetime}
        extraDurations={[initial.duration]}
        detailed={detailed}
        onDisclose={() => setDetailed(true)}
        titleHint={
          unreadable.has('title')
            ? undefined
            : 'Encrypted on this device before it is saved.'
        }
      />

      {/* BELOW the fields, because "which occurrences?" is unanswerable before you have
          decided what you are changing — and directly above the actions, so the last thing
          read before Save is what Save will do. */}
      {recurring && series !== null && (
        <fieldset className={styles.scope}>
          <legend className={styles.scopeLegend}>Change</legend>
          {(Object.keys(SCOPE_COPY) as Scope[]).map((option) => (
            <label key={option} className={styles.scopeRow}>
              <input
                type="radio"
                name="scope"
                value={option}
                checked={scope === option}
                disabled={busy}
                onChange={() => setScope(option)}
              />
              {SCOPE_COPY[option].label}
            </label>
          ))}
          <p className={styles.note} aria-live="polite">
            {SCOPE_COPY[scope].consequence}
            {scope === 'entire-series' && ' The time cannot be changed for the whole series yet.'}
          </p>
        </fieldset>
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
