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

/**
 * Parse a `?date=YYYY-MM-DD` anchor. Anything absent or unparseable falls back to TODAY
 * in the display zone — the same graceful degradation every view shares, so a mangled URL
 * lands somewhere sensible rather than on an error page.
 */
export function anchorFromParam(
  date: string | undefined,
  timezone: string = DISPLAY_TIMEZONE,
): Temporal.PlainDate {
  if (date !== undefined && /^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    try {
      return Temporal.PlainDate.from(date)
    } catch {
      // Shaped like a date but not one (2026-02-31). Fall through to today.
    }
  }
  return Temporal.Now.zonedDateTimeISO(timezone).toPlainDate()
}

/** Parse a `?week=YYYY-MM-DD` param. Anything unparseable falls back to the current week. */
export function rangeFromParam(
  week: string | undefined,
  timezone: string = DISPLAY_TIMEZONE,
  weekStart: WeekStart = 0,
): CalendarRange {
  return weekRange(
    anchorFromParam(week, timezone).toZonedDateTime({ timeZone: timezone }),
    weekStart,
  )
}

/** One local day, [midnight, next midnight). DST-safe the same way weekRange is. */
export function dayRange(anchor: Temporal.PlainDate, timezone: string): CalendarRange {
  const from = anchor.toZonedDateTime({ timeZone: timezone }).startOfDay()
  const to = from.add({ days: 1 })
  return { from: from.toInstant().toString(), to: to.toInstant().toString() }
}

/**
 * The VISIBLE month grid: six fixed rows of seven, starting on the configured week start —
 * 42 days, not the calendar month. The grid renders the leading and trailing days either
 * way, and a cell that renders as empty while events exist on it is a cell that lies;
 * fetching the whole grid is the honest version. Six rows always, for the same reason the
 * mini month commits to them: a month view that changes height as you step through the
 * year reads as jumpy, not accurate.
 */
export function monthGridRange(
  anchor: Temporal.PlainDate,
  timezone: string,
  weekStart: WeekStart = 0,
): CalendarRange {
  const first = anchor.with({ day: 1 })
  const isoDay = first.dayOfWeek % 7
  const back = (isoDay - weekStart + 7) % 7
  const gridFirst = first.subtract({ days: back })

  const from = gridFirst.toZonedDateTime({ timeZone: timezone }).startOfDay()
  // Added as calendar days on the zoned start, so a DST shift inside the grid moves an
  // hour of instants without ever moving a wall date.
  const to = from.add({ days: 42 })
  return { from: from.toInstant().toString(), to: to.toInstant().toString() }
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

/** Same table idiom as MONTHS, same reason: formatting an instant without an explicit
 *  zone renders it in the HOST zone. PlainDate.dayOfWeek is 1 = Monday … 7 = Sunday. */
const WEEKDAYS = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
] as const

/** "Tuesday, August 12, 2026" — the day view's heading. */
export function formatDay(anchor: Temporal.PlainDate): string {
  return `${WEEKDAYS[anchor.dayOfWeek - 1]}, ${monthName(anchor.month)} ${anchor.day}, ${anchor.year}`
}

/**
 * "August 2026" — from the ANCHOR, never from formatRange of the grid range, whose ends
 * live in the neighbouring months.
 */
export function formatMonth(anchor: Temporal.PlainDate): string {
  return `${monthName(anchor.month)} ${anchor.year}`
}

/** The `?date=` value for an anchor. */
export function dateParam(anchor: Temporal.PlainDate): string {
  return anchor.toString()
}

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

/**
 * THE PHONE'S HEADING, and it exists because a heading that wraps is a heading that eats
 * the calendar.
 *
 * Measured at 390px: the header spends 288 of its 390px on fixed chrome (logo, two
 * steppers, Settings, and until this pass a theme toggle), leaving about 102px for the
 * date. `formatDay`'s "Thursday, August 20, 2026" is 25 characters — three lines in
 * Marcellus at 16px, which took the header from 69px to 97px on the one view where the
 * calendar needs the room most.
 *
 * So the phone gets a SHORTER STRING rather than a smaller one. Day drops to the month,
 * because the week strip directly below already rings the selected date and the rule for
 * this pass is exactly one date representation per screen. Week and agenda keep both ends
 * and the year, abbreviated — a range is not recoverable from anything else on screen, so
 * it may not be dropped.
 *
 * Month is unchanged: `formatMonth` is already short.
 */
const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const

const shortMonth = (month: number): string => MONTHS_SHORT[month - 1] ?? ''

/**
 * "Aug 17–23, 2026" — the same range as `formatRange`, abbreviated for a phone header.
 *
 * THE EN DASH IS UNSPACED HERE AND SPACED IN `formatRange`, and that is not an
 * inconsistency to tidy away. Measured at 390px: the heading gets 123px, and the spaced
 * "May 18 – 24, 2026" needs more than that, so it wrapped to two lines and took the header
 * from 69px to 89px on week and agenda. Closing the two spaces is 15 characters instead of
 * 17 and fits.
 *
 * It is also the more correct setting. A number range takes an unspaced en dash; the spaced
 * form belongs to ranges whose ends are themselves multi-word. `formatRange` keeps the
 * spaces because its ends ARE multi-word ("May 18 – June 2, 2026") and it has the room.
 *
 * Not an em dash. The project bans U+2014 in user-facing copy; U+2013 in a range is what
 * the agenda, the week heading and the .ics exporter already use.
 */
export function formatRangeCompact(range: CalendarRange, timezone: string): string {
  const from = Temporal.Instant.from(range.from).toZonedDateTimeISO(timezone)
  const last = Temporal.Instant.from(range.to).toZonedDateTimeISO(timezone).subtract({ days: 1 })

  if (from.year === last.year && from.month === last.month) {
    return `${shortMonth(from.month)} ${from.day}–${last.day}, ${from.year}`
  }
  if (from.year === last.year) {
    return `${shortMonth(from.month)} ${from.day}–${shortMonth(last.month)} ${last.day}, ${from.year}`
  }
  return `${shortMonth(from.month)} ${from.day}, ${from.year}–${shortMonth(last.month)} ${last.day}, ${last.year}`
}

/** The `?week=` value for a range — always the local date of its first day. */
export function weekParam(range: CalendarRange, timezone: string): string {
  return Temporal.Instant.from(range.from).toZonedDateTimeISO(timezone).toPlainDate().toString()
}
