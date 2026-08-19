'use client'

import { useEffect, useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Temporal } from '@js-temporal/polyfill'
import { useCloakStore } from './cloak-provider'
import { EventSheet } from './event-sheet'
import { EventFields, Field, eventFieldStyles, type EventFieldValues } from './event-fields'
import { sealFields } from '@/lib/cloaked-fields'
import { resolveOwnWorkspace } from '@/lib/own-workspace'
import type { SavedEvent } from '@/lib/saved-event'
import { supabaseBrowser } from '@/lib/supabase/client'
import { useCloakedLabels } from './use-cloaked-labels'
import { Button } from './ui/button'
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
 *
 * The modal shell and the fields live in EventSheet and EventFields, which the edit sheet
 * also uses. Only the create-specific parts are here: resolving the target calendar, the
 * repeat rule, and the create RPC.
 */

const REPEATS = [
  { value: '', label: 'Does not repeat' },
  { value: 'FREQ=DAILY', label: 'Daily' },
  { value: 'FREQ=WEEKLY', label: 'Weekly' },
  { value: 'FREQ=MONTHLY', label: 'Monthly' },
] as const

interface Target {
  readonly workspaceId: string
  /** Every active calendar, default first — the picker's option list. */
  readonly calendars: readonly string[]
}

const EMPTY = (defaultDate: string, defaultTime: string): EventFieldValues => ({
  title: '',
  date: defaultDate,
  time: defaultTime,
  duration: 30,
  location: '',
  notes: '',
})

/**
 * The triggers, split from the sheet so the mobile FAB and the desktop sidebar button can
 * open ONE shared compose sheet (whose open state lives in CalendarScreen). Which trigger
 * shows is CSS: the FAB below 900px, the sidebar block from it.
 */
export function NewEventButton({
  variant,
  onOpen,
}: {
  variant: 'fab' | 'block'
  onOpen: () => void
}) {
  const store = useCloakStore()
  const locked = store === null || !store.isUnlocked

  if (variant === 'block') {
    return (
      <Button
        className={styles.sidebarButton}
        disabled={locked}
        title={locked ? 'Unlock your calendar first' : undefined}
        aria-keyshortcuts="n"
        onClick={onOpen}
      >
        <span aria-hidden="true">+</span> New event
      </Button>
    )
  }

  return (
    <button
      type="button"
      className={styles.fab}
      disabled={locked}
      title={locked ? 'Unlock your calendar first' : 'New event'}
      onClick={onOpen}
    >
      <span aria-hidden="true">+</span>
      <span className={styles.fabLabel}>New event</span>
    </button>
  )
}

export function NewEvent({
  timezone,
  defaultDate,
  defaultTime = '09:00',
  demo = false,
  onSaved,
  onClose,
}: {
  timezone: string
  defaultDate: string
  /** HH:MM the sheet opens on — the clicked grid slot's hour, or the 09:00 default. */
  defaultTime?: string
  /**
   * Fixture mode's compose: the sheet opens, the fields work, and NOTHING can be written.
   * The demo has no session and no workspace, so a live Save could only fail confusingly;
   * disabling it (and skipping the workspace lookup) keeps "the fixture never writes" a
   * structural property rather than a hoped-for one. This is what lets the e2e suite
   * finally open the create path at all — axe had never seen this sheet.
   */
  demo?: boolean
  /**
   * Reported on success, before onClose. The screen decides what to do with it — see
   * CalendarScreen.reportSaved. Absent in the fixture, where nothing can be written anyway.
   *
   * NOTE THAT THE FAILURE PATH ALREADY DOES THE RIGHT THING and must keep doing it: onClose
   * is inside the try, after the RPC, so a rejected write leaves the sheet open with every
   * field exactly as typed. An edit that says "reload the page" throws away work.
   */
  onSaved?: ((result: SavedEvent) => void) | undefined
  onClose: () => void
}) {
  const store = useCloakStore()
  const router = useRouter()
  const repeatId = useId()
  const calendarSelectId = useId()

  const [target, setTarget] = useState<Target | null>(null)
  const [calendarId, setCalendarId] = useState<string | null>(null)
  const [values, setValues] = useState<EventFieldValues>(() => EMPTY(defaultDate, defaultTime))
  const [repeat, setRepeat] = useState('')
  const [detailed, setDetailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const calendarNames = useCloakedLabels('calendar', target?.calendars ?? [], 'display_name')

  // Resolved here rather than passed down from the server page, so the redacted payload
  // never has to carry a workspace id it would then be shipping to every audience. RLS
  // restricts this to the caller's own rows. Mounting is opening, so no `open` gate.
  useEffect(() => {
    // Demo: no session exists, so the lookup could only return nothing. Not fetching at
    // all keeps the fixture's network surface identical to the rest of the demo.
    if (demo || target !== null) return

    void (async () => {
      const workspaceId = await resolveOwnWorkspace()
      if (workspaceId === null) return

      // The LIST now, not just the default: since 0021 an account can hold several
      // calendars, and creating onto a silently-chosen one would file events somewhere
      // the user did not pick. Default first, so index 0 is the old behaviour.
      const { data: calendars } = await supabaseBrowser()
        .from('calendars')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('lifecycle', 'active')
        .order('is_default', { ascending: false })
        .order('sort_order', { ascending: true })
        .returns<{ id: string }[]>()
      if (calendars === null || calendars.length === 0) return

      setTarget({ workspaceId, calendars: calendars.map((c) => c.id) })
      setCalendarId(calendars[0]!.id)
    })()
  }, [target])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)

    // Belt to the disabled Save's braces: implicit form submission (Enter in a field) is
    // browser-defined territory, and this return is what makes "the demo cannot write" a
    // property of the code rather than of one button's disabled attribute.
    if (demo) return

    if (store === null || !store.isUnlocked) {
      setError('Your calendar is locked. Unlock it before adding an event.')
      return
    }
    if (target === null || calendarId === null) {
      setError('No calendar found for this account yet.')
      return
    }

    setBusy(true)
    try {
      // Generated here so the fields can be sealed against the event's real id before
      // anything is written. The AAD binds ciphertext to that id, so it has to exist first.
      const eventId = globalThis.crypto.randomUUID()

      const local = Temporal.PlainDateTime.from(`${values.date}T${values.time}:00`)
      const zoned = local.toZonedDateTime(timezone, { disambiguation: 'earlier' })
      const end = zoned.add({ minutes: values.duration })

      const content: Array<[string, string]> = [['title', values.title.trim()]]
      if (values.location.trim() !== '') content.push(['location', values.location.trim()])
      if (values.notes.trim() !== '') content.push(['notes', values.notes.trim()])

      const fields = await sealFields(store, 'event', eventId, content)

      const { error: rpcError } = await supabaseBrowser().rpc('create_cloaked_event', {
        p_event_id: eventId,
        p_workspace_id: target.workspaceId,
        p_calendar_id: calendarId,
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

      // Before onClose, so the screen has the result even though this component is about to
      // unmount. The date is the one the user chose, not the one the calendar is showing.
      onSaved?.({ eventId, date: values.date, kind: 'created' })
      onClose()
      setValues(EMPTY(defaultDate, defaultTime))
      setDetailed(false)
      router.refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <EventSheet
      title="New event"
      error={error}
      busy={busy}
      submitLabel={busy ? 'Encrypting and saving' : 'Save'}
      submitDisabled={demo}
      onSubmit={submit}
      onClose={onClose}
    >
      <EventFields
        values={values}
        onChange={(patch) => setValues((v) => ({ ...v, ...patch }))}
        disabled={busy}
        detailed={detailed}
        onDisclose={() => setDetailed(true)}
        titleHint={
          demo
            ? 'This is the demo calendar. Try the form; nothing typed here is saved or sent anywhere.'
            : 'Encrypted on this device before it is saved.'
        }
      >
        {/* Only when there is a real choice: one calendar needs no picker and the sheet
            stays minimal. Labels are decrypted client-side (ViewAsBar's pattern —
            an <option> holds text, so CloakedText cannot render inside one); before
            unlock the id prefix shows, which is what the server sees. */}
        {target !== null && target.calendars.length > 1 && (
          <Field label="Calendar" htmlFor={calendarSelectId}>
            <select
              id={calendarSelectId}
              className={eventFieldStyles.input}
              disabled={busy}
              value={calendarId ?? ''}
              onChange={(e) => setCalendarId(e.target.value)}
            >
              {target.calendars.map((id) => (
                <option key={id} value={id}>
                  {calendarNames[id] !== undefined && calendarNames[id] !== ''
                    ? calendarNames[id]
                    : `Calendar ${id.slice(0, 8)}`}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field label="Repeats" htmlFor={repeatId}>
          <select
            id={repeatId}
            className={eventFieldStyles.input}
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
        </Field>
      </EventFields>
    </EventSheet>
  )
}
