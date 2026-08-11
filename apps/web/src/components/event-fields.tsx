'use client'

import { useId, type ReactNode } from 'react'
import styles from './event-fields.module.css'

/**
 * The event form's fields, fully controlled and entirely presentational.
 *
 * NO STATE, NO CRYPTO, NO NETWORK. Values in, changes out. Create and edit differ in what
 * they do with the values, not in how the values are collected, and this is the part they
 * genuinely share — so it is the only part extracted. The two submit paths stay separate:
 * different RPC, version guard or not, pre-fill or not, one failure mode or three. Merging
 * those would put a branch in every interesting line.
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
                value={values.duration}
                onChange={(e) => onChange({ duration: Number(e.target.value) })}
              >
                {durations.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {formatDuration(minutes)}
                  </option>
                ))}
              </select>
            </div>

            {children}
          </div>
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

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const hours = minutes / 60
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hr`
}
