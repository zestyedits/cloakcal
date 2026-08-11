import { Temporal } from '@js-temporal/polyfill'
import { RRule } from 'rrule'

/**
 * Recurrence expansion — wall-clock preserving, per ADR 0001.
 *
 * THE RULE: a series is a repeating *wall-clock reading*, not a repeating instant.
 * "09:00 every Tuesday" stays 09:00 after a DST transition. So expansion happens entirely
 * in local time, and only then is each occurrence resolved to an instant in the series'
 * IANA zone under an explicit disambiguation policy.
 *
 * JavaScript `Date` NEVER decides DST behaviour here. It appears in exactly one place — as
 * a carrier for rrule's floating-time convention — and every field is read back through
 * `getUTC*`, so the host machine's local zone cannot influence any result. Anything that
 * matters is decided by Temporal with an explicit policy.
 */

/** How an occurrence's local time was resolved against its zone. */
export type DstAdjustment =
  | 'none'
  /** Local time occurred twice (fall back). ADR 0001: take the earlier. */
  | 'ambiguous-earlier'
  /** Local time did not occur (spring forward). ADR 0001: shift forward by the gap. */
  | 'nonexistent-shifted'

export interface SeriesSpec {
  /** Local wall-clock anchor, `YYYY-MM-DDTHH:mm[:ss]`. Maps to events.dtstart_local. */
  readonly dtstartLocal: string
  readonly durationMinutes: number
  /** IANA zone. Maps to events.timezone. */
  readonly timezone: string
  /** RFC 5545 RRULE text without the `RRULE:` prefix. `null` for a single event. */
  readonly rrule: string | null
}

export interface Occurrence {
  /**
   * The ORIGINAL local occurrence, before any DST adjustment.
   *
   * This is the exception key (`recurrence_exceptions.occurrence_local`). It is stable
   * across DST transitions precisely because it is the pre-resolution value: keying by the
   * adjusted instant would let a shift change the key and resurrect a cancelled occurrence.
   */
  readonly occurrenceLocal: string
  /** Resolved start, ISO 8601 with offset and zone. */
  readonly start: string
  readonly end: string
  /** UTC instant, for range comparison and indexing. */
  readonly startInstant: string
  readonly dst: DstAdjustment
}

export interface ExceptionSpec {
  /** Matches Occurrence.occurrenceLocal exactly. */
  readonly occurrenceLocal: string
  readonly kind: 'cancelled' | 'moved'
}

export interface ExpandRange {
  /** Inclusive lower bound, ISO instant. */
  readonly from: string
  /** Exclusive upper bound, ISO instant. */
  readonly to: string
}

/**
 * rrule operates on JS Dates. The standard technique for floating (zoneless) recurrence is
 * to encode local wall-clock fields into a Date's UTC fields — the Date is never a real
 * instant, just a carrier. Both directions use UTC accessors only, so the host zone is
 * irrelevant.
 */
const toFloatingDate = (pdt: Temporal.PlainDateTime): Date =>
  new Date(Date.UTC(pdt.year, pdt.month - 1, pdt.day, pdt.hour, pdt.minute, pdt.second))

const fromFloatingDate = (date: Date): Temporal.PlainDateTime =>
  new Temporal.PlainDateTime(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  )

/**
 * Resolve one local wall-clock reading to an instant, applying ADR 0001's policy.
 *
 * The two DST cases are told apart by whether the wall clock survives the round trip:
 *   - ambiguous  → both `earlier` and `later` return the requested wall time, differing
 *                  only in UTC offset.
 *   - nonexistent → neither returns the requested wall time; `earlier` moves back before
 *                  the gap, `later` moves forward past it.
 *
 * Temporal exposes a single `disambiguation` option that would apply one choice to both
 * cases, but ADR 0001 requires different choices, so the case is detected explicitly.
 */
export function resolveLocal(
  local: Temporal.PlainDateTime,
  timezone: string,
): { zoned: Temporal.ZonedDateTime; dst: DstAdjustment } {
  const earlier = local.toZonedDateTime(timezone, { disambiguation: 'earlier' })
  const later = local.toZonedDateTime(timezone, { disambiguation: 'later' })

  if (earlier.equals(later)) {
    return { zoned: earlier, dst: 'none' }
  }

  if (earlier.toPlainDateTime().equals(local)) {
    // Fall back: the reading is real, it simply happens twice. Take the first pass.
    return { zoned: earlier, dst: 'ambiguous-earlier' }
  }

  // Spring forward: the reading never happens. Shift forward by the gap length, which is
  // what `later` yields (02:30 in a 02:00-03:00 gap becomes 03:30, not 03:00).
  return { zoned: later, dst: 'nonexistent-shifted' }
}

/**
 * Resolve a local occurrence key to an ISO instant, applying the ADR 0001 policy.
 *
 * Exists so consumers (the CRUD service, later the API) can compare occurrence times
 * without importing Temporal or hand-rolling zone maths — the DST policy stays in exactly
 * one place, which is the entire point of this module.
 */
export function occurrenceInstant(occurrenceLocal: string, timezone: string): string {
  const { zoned } = resolveLocal(Temporal.PlainDateTime.from(occurrenceLocal), timezone)
  return zoned.toInstant().toString()
}

/**
 * How many occurrences the rule produces strictly before a local wall time.
 *
 * Lives here rather than in edit-scope.ts because it has to count in the SAME floating
 * convention expansion uses — encoding local fields into a Date's UTC fields. A second
 * implementation that reached for real instants would drift from expandSeries across a DST
 * boundary and disagree about how many occurrences a split consumes.
 *
 * Counting, not expanding: no zone resolution happens, so `COUNT` arithmetic stays a
 * question about the RULE rather than about the calendar it lands on.
 */
export function countOccurrencesBefore(spec: SeriesSpec, beforeLocal: string): number {
  if (spec.rrule === null) return 0

  const dtstart = toFloatingDate(Temporal.PlainDateTime.from(spec.dtstartLocal))
  const before = toFloatingDate(Temporal.PlainDateTime.from(beforeLocal))
  if (before <= dtstart) return 0

  const options = RRule.parseString(spec.rrule)
  const rule = new RRule({ ...options, dtstart })

  // `between` is inclusive at both ends when inc is true, so the upper bound is filtered
  // back off: an occurrence AT the split belongs to the successor, not to what came before.
  return rule.between(dtstart, before, true).filter((date) => date < before).length
}

/** Local candidates, before zone resolution and before exceptions. */
function localCandidates(spec: SeriesSpec, windowFrom: Date, windowTo: Date): Date[] {
  const dtstart = toFloatingDate(Temporal.PlainDateTime.from(spec.dtstartLocal))

  if (spec.rrule === null) {
    return dtstart >= windowFrom && dtstart <= windowTo ? [dtstart] : []
  }

  const options = RRule.parseString(spec.rrule)
  const rule = new RRule({ ...options, dtstart })
  return rule.between(windowFrom, windowTo, true)
}

/**
 * Expand a series into resolved occurrences overlapping `range`.
 *
 * The local expansion window is widened by two days on each side before filtering on the
 * resolved instant. Without the padding, an occurrence near a range edge whose offset
 * shifts it across the boundary would be dropped.
 */
export function expandSeries(
  spec: SeriesSpec,
  range: ExpandRange,
  exceptions: readonly ExceptionSpec[] = [],
): Occurrence[] {
  if (spec.durationMinutes < 0) {
    throw new Error('durationMinutes must not be negative')
  }

  const from = Temporal.Instant.from(range.from)
  const to = Temporal.Instant.from(range.to)
  if (Temporal.Instant.compare(from, to) > 0) {
    throw new Error('range.from must not be after range.to')
  }

  const pad = { days: 2 }
  const windowFrom = toFloatingDate(
    from.toZonedDateTimeISO(spec.timezone).toPlainDateTime().subtract(pad),
  )
  const windowTo = toFloatingDate(to.toZonedDateTimeISO(spec.timezone).toPlainDateTime().add(pad))

  const cancelled = new Set(
    exceptions.filter((e) => e.kind === 'cancelled').map((e) => e.occurrenceLocal),
  )
  // A moved occurrence is removed from the series; its replacement is a separate event row.
  const moved = new Set(exceptions.filter((e) => e.kind === 'moved').map((e) => e.occurrenceLocal))

  const out: Occurrence[] = []

  for (const candidate of localCandidates(spec, windowFrom, windowTo)) {
    const local = fromFloatingDate(candidate)
    const occurrenceLocal = local.toString()

    if (cancelled.has(occurrenceLocal) || moved.has(occurrenceLocal)) continue

    const { zoned, dst } = resolveLocal(local, spec.timezone)
    const instant = zoned.toInstant()

    // Half-open [from, to): an occurrence starting exactly at `to` belongs to the next page.
    if (Temporal.Instant.compare(instant, from) < 0) continue
    if (Temporal.Instant.compare(instant, to) >= 0) continue

    out.push({
      occurrenceLocal,
      start: zoned.toString(),
      end: zoned.add({ minutes: spec.durationMinutes }).toString(),
      startInstant: instant.toString(),
      dst,
    })
  }

  return out
}

/* -------------------------------------------------------------------------- */
/* All-day events                                                             */
/* -------------------------------------------------------------------------- */

export interface AllDaySpec {
  /** `YYYY-MM-DD`. Maps to events.start_date. */
  readonly startDate: string
  /** `YYYY-MM-DD`, inclusive. Maps to events.end_date. */
  readonly endDate: string
  readonly rrule: string | null
}

export interface AllDayOccurrence {
  readonly occurrenceLocal: string
  readonly startDate: string
  readonly endDate: string
}

/**
 * All-day expansion never touches a timezone.
 *
 * That is the whole point: an all-day event is a date, not a midnight instant. Storing it
 * as a timestamp is the classic bug where a birthday drifts to the previous day for anyone
 * east of the author. There is deliberately no `timezone` parameter here — the type system
 * makes the mistake unavailable.
 */
export function expandAllDay(
  spec: AllDaySpec,
  range: { from: string; to: string },
  exceptions: readonly ExceptionSpec[] = [],
): AllDayOccurrence[] {
  const start = Temporal.PlainDate.from(spec.startDate)
  const end = Temporal.PlainDate.from(spec.endDate)
  if (Temporal.PlainDate.compare(end, start) < 0) {
    throw new Error('endDate must not be before startDate')
  }
  const spanDays = start.until(end).days

  const from = Temporal.PlainDate.from(range.from)
  const to = Temporal.PlainDate.from(range.to)

  const asDate = (d: Temporal.PlainDate) => new Date(Date.UTC(d.year, d.month - 1, d.day))
  const dtstart = asDate(start)

  const candidates =
    spec.rrule === null
      ? dtstart >= asDate(from) && dtstart <= asDate(to)
        ? [dtstart]
        : []
      : new RRule({ ...RRule.parseString(spec.rrule), dtstart }).between(
          asDate(from),
          asDate(to),
          true,
        )

  const skip = new Set(exceptions.map((e) => e.occurrenceLocal))

  return candidates
    .map((d) => Temporal.PlainDate.from({
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
    }))
    .filter((d) => !skip.has(d.toString()))
    .map((d) => ({
      occurrenceLocal: d.toString(),
      startDate: d.toString(),
      endDate: d.add({ days: spanDays }).toString(),
    }))
}
