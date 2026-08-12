import { Temporal } from '@js-temporal/polyfill'
import type { CalendarRange } from './events'

/**
 * Which week a page is showing.
 *
 * Built from Temporal rather than Date arithmetic. "Add seven days" is not "add 604800
 * seconds": across a DST boundary those differ by an hour, and a week view that quietly
 * starts at 23:00 on one Sunday a year is the kind of bug nobody reports and everybody
 * notices. Temporal's ZonedDateTime add() is calendar-aware, so the week always begins at
 * local midnight.
 *
 * The range is half-open [from, to), matching expandSeries: an event starting exactly at
 * the boundary belongs to the next week, never to both.
 */

/**
 * The FALLBACK display timezone.
 *
 * Since 0018 the real preference lives on `workspaces.timezone` and the settings screen
 * changes it; this constant remains for the fixture, for accounts with no workspace yet,
 * and as the value a broken stored zone degrades to. Events carry their own IANA zone;
 * this is only the zone the *view* is framed in (ADR 0001 — display framing, never
 * storage).
 */
export const DISPLAY_TIMEZONE = 'America/New_York'

/**
 * A stored zone the runtime cannot use degrades to the default instead of throwing.
 *
 * The column's CHECK is a shape check only — deliberately, because PGlite's tz table must
 * not be load-bearing — so a value can be well-shaped and still unknown to this runtime
 * (or valid in a future tz database and unknown to an older one). A calendar that 500s
 * over a timezone string fails its actual job; a calendar framed in the default is wrong
 * in a way the settings screen can fix.
 */
export function safeTimezone(zone: string | undefined): string {
  if (zone === undefined) return DISPLAY_TIMEZONE
  try {
    Temporal.Now.zonedDateTimeISO(zone)
    return zone
  } catch {
    return DISPLAY_TIMEZONE
  }
}

/** 0 = Sunday, matching workspaces.week_start. */
export type WeekStart = 0 | 1 | 2 | 3 | 4 | 5 | 6

export function weekRange(
  reference: Temporal.ZonedDateTime,
  weekStart: WeekStart = 0,
): CalendarRange {
  // Temporal's dayOfWeek is 1 = Monday … 7 = Sunday; week_start is 0 = Sunday.
  const isoDay = reference.dayOfWeek % 7
  const back = (isoDay - weekStart + 7) % 7

  const from = reference.startOfDay().subtract({ days: back })
  const to = from.add({ days: 7 })

  return { from: from.toInstant().toString(), to: to.toInstant().toString() }
}

export function currentWeek(
  timezone: string = DISPLAY_TIMEZONE,
  weekStart: WeekStart = 0,
): CalendarRange {
  return weekRange(Temporal.Now.zonedDateTimeISO(timezone), weekStart)
}

/** Shift a range by whole weeks — what the ‹ › controls do. */
export function shiftWeeks(range: CalendarRange, weeks: number, timezone: string): CalendarRange {
  const from = Temporal.Instant.from(range.from).toZonedDateTimeISO(timezone).add({ weeks })
  const to = from.add({ days: 7 })
  return { from: from.toInstant().toString(), to: to.toInstant().toString() }
}

/** Parse a `?week=YYYY-MM-DD` param. Anything unparseable falls back to the current week. */
export function rangeFromParam(
  week: string | undefined,
  timezone: string = DISPLAY_TIMEZONE,
  weekStart: WeekStart = 0,
): CalendarRange {
  if (week === undefined || !/^\d{4}-\d{2}-\d{2}$/u.test(week)) return currentWeek(timezone, weekStart)

  try {
    const anchor = Temporal.PlainDate.from(week).toZonedDateTime({ timeZone: timezone })
    return weekRange(anchor, weekStart)
  } catch {
    return currentWeek(timezone, weekStart)
  }
}

/**
 * Month names are looked up from the Temporal month number rather than by formatting an
 * instant. Formatting an instant without an explicit `timeZone` renders it in the HOST
 * zone, which is exactly the class of bug that made a 09:00 event read as 17:00 during the
 * CRUD work — and it only shows up on a machine set to a different zone than the developer's.
 */
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const

const monthName = (month: number): string => MONTHS[month - 1] ?? ''

/** "May 18 – 24, 2026", collapsing the month when both ends share one. */
export function formatRange(range: CalendarRange, timezone: string): string {
  const from = Temporal.Instant.from(range.from).toZonedDateTimeISO(timezone)
  // `to` is exclusive, so the last day shown is the day before it.
  const last = Temporal.Instant.from(range.to).toZonedDateTimeISO(timezone).subtract({ days: 1 })

  if (from.year === last.year && from.month === last.month) {
    return `${monthName(from.month)} ${from.day} – ${last.day}, ${from.year}`
  }
  if (from.year === last.year) {
    return `${monthName(from.month)} ${from.day} – ${monthName(last.month)} ${last.day}, ${from.year}`
  }
  return `${monthName(from.month)} ${from.day}, ${from.year} – ${monthName(last.month)} ${last.day}, ${last.year}`
}

/** The `?week=` value for a range — always the local date of its first day. */
export function weekParam(range: CalendarRange, timezone: string): string {
  return Temporal.Instant.from(range.from).toZonedDateTimeISO(timezone).toPlainDate().toString()
}
