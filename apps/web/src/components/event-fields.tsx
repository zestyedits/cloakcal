'use client'

import { useId, useState, type ReactNode } from 'react'
import { Temporal } from '@js-temporal/polyfill'
import { wallTimeLabel } from '@/lib/wall-time'
import styles from './event-fields.module.css'

/**
 * The event form's fields, fully controlled and entirely presentational.
 *
 * NO VALUE STATE, NO CRYPTO, NO NETWORK. Values in, changes out. Create and edit differ in
 * what they do with the values, not in how the values are collected, and this is the part
 * they genuinely share — so it is the only part extracted. The two submit paths stay
 * separate: different RPC, version guard or not, pre-fill or not, one failure mode or
 * three. Merging those would put a branch in every interesting line.
 *
 * The one piece of local state is the custom-duration MODE (and its raw text) — which
 * control collects the minutes, never what the minutes are. The value itself still flows
 * out through onChange like every other field, so the create and edit sheets stay the
 * single source of truth for what will be saved.
 *
 * IDS COME FROM useId(). The markup this replaces hardcoded `event-title`, `event-date` and
 * friends, which is fine for exactly as long as only one sheet can exist. An edit sheet and
 * a create sheet open at once would have produced duplicate ids and labels pointing at the
 * wrong control — a bug that reads as "the label is broken" rather than "the id collided".
 */

export const DURATIONS = [15, 30, 45, 60, 90, 120] as const

export interface EventFieldValues {
  readonly title: string
  readonly date: string
  readonly time: string
  readonly duration: number
  readonly location: string
  readonly notes: string
}

export function EventFields({
  values,
  onChange,
  disabled = false,
  /** Hidden entirely when a scope cannot change them — see the edit sheet for why. */
  showWhen = true,
  /** Extra choices beyond DURATIONS, so opening a sheet never silently rounds a duration. */
  extraDurations = [],
  detailed,
  onDisclose,
  titleHint,
  /** Rendered between the timing controls and the detail disclosure. */
  children,
}: {
  values: EventFieldValues
  onChange: (patch: Partial<EventFieldValues>) => void
  disabled?: boolean
  showWhen?: boolean
  extraDurations?: readonly number[]
  detailed: boolean
  onDisclose: () => void
  titleHint?: ReactNode
  children?: ReactNode
}) {
  const id = useId()
  const durations = [...new Set([...DURATIONS, ...extraDurations])].sort((a, b) => a - b)
  const span = resolveSpan(values.date, values.time, values.duration)

  // Custom-duration mode. Opened by the select's last option, closed by picking any
  // preset. The raw text is kept separately from values.duration so someone can clear the
  // field mid-edit without the form fighting them; only a valid whole number of minutes is
  // ever pushed out through onChange, and the input's own required/min validation blocks a
  // submit while the text is not one — so a stale duration can never ride out on a save.
  const [customOpen, setCustomOpen] = useState(false)
  const [customText, setCustomText] = useState('')

  return (
    <>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-title`}>
          What is it
        </label>
        <input
          id={`${id}-title`}
          className={styles.input}
          required
          autoFocus
          maxLength={200}
          disabled={disabled}
          value={values.title}
          onChange={(e) => onChange({ title: e.target.value })}
        />
        {titleHint !== undefined && <p className={styles.hint}>{titleHint}</p>}
      </div>

      {showWhen && (
        <>
          <div className={styles.row}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`${id}-date`}>
                Day
              </label>
              <input
                id={`${id}-date`}
                className={styles.input}
                type="date"
                required
                disabled={disabled}
                value={values.date}
                onChange={(e) => onChange({ date: e.target.value })}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor={`${id}-time`}>
                Starts
              </label>
              <input
                id={`${id}-time`}
                className={styles.input}
                type="time"
                required
                disabled={disabled}
                value={values.time}
                onChange={(e) => onChange({ time: e.target.value })}
              />
            </div>
          </div>

          <div className={styles.row}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`${id}-duration`}>
                For
              </label>
              <select
                id={`${id}-duration`}
                className={styles.input}
                disabled={disabled}
                value={customOpen ? 'custom' : values.duration}
                onChange={(e) => {
                  if (e.target.value === 'custom') {
                    setCustomOpen(true)
                    setCustomText(String(values.duration))
                    return
                  }
                  setCustomOpen(false)
                  onChange({ duration: Number(e.target.value) })
                }}
              >
                {durations.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {formatDuration(minutes)}
                  </option>
                ))}
                <option value="custom">Custom minutes</option>
              </select>
              {customOpen && (
                <>
                  <label className={styles.label} htmlFor={`${id}-custom-minutes`}>
                    Minutes
                  </label>
                  <input
                    id={`${id}-custom-minutes`}
                    className={styles.input}
                    type="number"
                    inputMode="numeric"
                    // The floor matches the read side (initialTiming clamps to 1) and the
                    // cap is a day: end_utc is derived as start + duration, and a typo'd
                    // 90000 would quietly write an event ending months out.
                    min={1}
                    max={1440}
                    step={1}
                    required
                    disabled={disabled}
                    value={customText}
                    onChange={(e) => {
                      setCustomText(e.target.value)
                      const minutes = Math.floor(Number(e.target.value))
                      if (e.target.value !== '' && Number.isFinite(minutes) && minutes >= 1) {
                        onChange({ duration: Math.min(minutes, 1440) })
                      }
                    }}
                  />
                </>
              )}
            </div>

            {children}
          </div>

          {/* WHEN IT ENDS, said out loud. `aria-live` on this line alone rather than on the
              whole timing group: a duration change should announce the new span, not
              re-read three fields the user is already in.

              Absent rather than blank while the fields are mid-edit -- an empty dash where a
              time belongs reads as a broken readout, and `Temporal.from` throws on a partly
              typed date, which is exactly the state a form is in most of the time. */}
          {span !== null && (
            <p className={styles.timing} aria-live="polite">
              <span>
                {span.from} &ndash; {span.to}
              </span>
              {span.nextDay && <span className={styles.timingNote}>ends the next day</span>}
            </p>
          )}
        </>
      )}

      {detailed ? (
        <>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={`${id}-location`}>
              Where
            </label>
            <input
              id={`${id}-location`}
              className={styles.input}
              disabled={disabled}
              value={values.location}
              onChange={(e) => onChange({ location: e.target.value })}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={`${id}-notes`}>
              Notes
            </label>
            <textarea
              id={`${id}-notes`}
              className={styles.textarea}
              disabled={disabled}
              value={values.notes}
              onChange={(e) => onChange({ notes: e.target.value })}
            />
          </div>
        </>
      ) : (
        <button type="button" className={styles.disclose} onClick={onDisclose}>
          Add where and notes
        </button>
      )}
    </>
  )
}

/** Exported so the repeat select in the create sheet can share the field/label wrapper. */
export function Field({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor: string
  children: ReactNode
}) {
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  )
}

export { styles as eventFieldStyles }

/**
 * The wall-clock span the form currently describes, or null when it does not describe one.
 *
 * PlainDateTime arithmetic, never `new Date()`: these are local wall values and a Date would
 * reintroduce the host timezone, which is the trap ADR 0001 exists to keep out of this
 * codebase. No zone is needed anyway -- "09:00 plus 30 minutes" is a question about a wall
 * clock, and the answer does not change with a DST rule.
 *
 * Returns null rather than throwing on a half-typed date, which is the normal state of a
 * form. The caller renders nothing at all in that case.
 */
function resolveSpan(
  date: string,
  time: string,
  duration: number,
): { from: string; to: string; nextDay: boolean } | null {
  if (date === '' || time === '' || !Number.isFinite(duration) || duration < 1) return null
  try {
    const start = Temporal.PlainDateTime.from(`${date}T${time}:00`)
    const end = start.add({ minutes: duration })
    return {
      from: wallTimeLabel(start.toString()),
      to: wallTimeLabel(end.toString()),
      nextDay: Temporal.PlainDate.compare(end.toPlainDate(), start.toPlainDate()) > 0,
    }
  } catch {
    return null
  }
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const hours = minutes / 60
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hr`
}
