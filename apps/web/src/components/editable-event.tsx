'use client'

import { useState, type ReactNode } from 'react'
import { useCloakStore } from './cloak-provider'
import { EditEvent } from './edit-event'
import type { DeletedEvent, SavedEvent } from '@/lib/saved-event'
import styles from './editable-event.module.css'

/**
 * Makes an agenda row open its edit sheet.
 *
 * WHY THE ROW AND NOT AN EDIT BUTTON. The row is already a four-column grid — time, title,
 * busy pill, Delete — and a second 44px control beside Delete would squeeze the title
 * column, which is the one that already collapses first on a phone. Tapping the event to
 * open it is also what every calendar on every platform does, so it needs no affordance to
 * teach.
 *
 * IT LIVES HERE, NOT IN calendar-screen.tsx, for a boring but load-bearing reason:
 * CalendarScreen RENDERS CloakProvider, so its own hooks run outside that provider and
 * `useCloakStore()` there would always be null. This component is a child, so it is inside.
 *
 * DISABLED, NOT ABSENT, WHEN LOCKED. Editing needs a key — the form is pre-filled from
 * decrypted values. A row that silently stops responding reads as broken, so the control
 * stays present and says why, and the title keeps full contrast rather than being greyed
 * along with it.
 */
export function EditableEvent({
  eventId,
  version,
  recurring,
  series,
  occurrenceLocal,
  timezone,
  start,
  end,
  /** Describes the event without naming it — the title is encrypted and stays that way. */
  label,
  variant = 'row',
  onSaved,
  onDeleted,
  children,
}: {
  eventId: string
  version: number
  recurring: boolean
  series: { dtstartLocal: string; rrule: string; durationMinutes: number } | null
  occurrenceLocal: string
  timezone: string
  start: string
  end: string
  label: string
  /**
   * 'row' wraps the agenda row's title column, as always. 'block' is the week/day grid's
   * door: a stretched invisible button over the whole event block, because the block's
   * content is laid out by the grid and a wrapping button would fight the absolute
   * positioning. Its accessible name is built from the LABEL only — time, never title —
   * so the no-plaintext-in-constructed-names rule holds by construction.
   */
  variant?: 'row' | 'block'
  /** Forwarded to the sheet. Threaded as a prop, exactly like onOpenVisibility. */
  onSaved?: ((result: SavedEvent) => void) | undefined
  /** Forwarded to the sheet's Delete flow, so the screen can offer an undo. */
  onDeleted?: ((info: DeletedEvent) => void) | undefined
  children?: ReactNode
}) {
  const store = useCloakStore()
  const [editing, setEditing] = useState(false)
  const locked = store === null || !store.isUnlocked

  return (
    <>
      <button
        type="button"
        className={variant === 'block' ? styles.blockTrigger : styles.trigger}
        disabled={locked}
        title={locked ? 'Unlock your calendar first' : undefined}
        {...(variant === 'block' ? { 'aria-label': `Edit ${label}` } : {})}
        onClick={() => setEditing(true)}
      >
        {children}
        {/* Row variant: the accessible name is the decrypted title, or the placeholder when
            locked — no aria-label is constructed anywhere, so nothing new can carry
            plaintext. This just says what the control DOES. */}
        {variant === 'row' && <span className={styles.action}>, edit {label}</span>}
      </button>

      {editing && (
        // Keyed on the event so switching rows re-seeds the form. The sheet reads the store
        // once on mount and never again; without the key, opening a different event would
        // show the previous one's values.
        <EditEvent
          key={`${eventId}:${occurrenceLocal}`}
          eventId={eventId}
          version={version}
          recurring={recurring}
          series={series}
          occurrenceLocal={occurrenceLocal}
          timezone={timezone}
          start={start}
          end={end}
          label={label}
          onSaved={onSaved}
          onDeleted={onDeleted}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  )
}
