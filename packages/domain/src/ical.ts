import { Temporal } from '@js-temporal/polyfill'
import { resolveLocal, type SeriesSpec } from './recurrence.js'

/**
 * The iCalendar boundary.
 *
 * Internally, series are wall-clock anchored and every recurrence value — DTSTART and
 * UNTIL alike — carries floating local fields (ADR 0001, and the `Z` note in
 * edit-scope.ts). RFC 5545 does not work that way: for a series with a TZID, DTSTART is
 * local-with-TZID but **UNTIL must be UTC**.
 *
 * Converting between the two is the single most error-prone step in export, because UNTIL
 * is *inclusive*. Convert it wrongly and the last occurrence of every truncated series
 * disappears — or worse, appears for the exporter and not for the recipient.
 *
 * This module is deliberately the only place that conversion happens.
 */

export interface IcalSeries {
  /** `DTSTART;TZID=Zone:YYYYMMDDTHHMMSS` */
  readonly dtstart: string
  /** `RRULE:...` with UNTIL in UTC, or null for a single event. */
  readonly rrule: string | null
  readonly timezone: string
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

const formatLocalCompact = (local: Temporal.PlainDateTime): string =>
  `${pad(local.year, 4)}${pad(local.month)}${pad(local.day)}T${pad(local.hour)}${pad(local.minute)}${pad(local.second)}`

const formatUtcCompact = (instant: Temporal.Instant): string => {
  const utc = instant.toZonedDateTimeISO('UTC')
  return `${formatLocalCompact(utc.toPlainDateTime())}Z`
}

const parseCompact = (value: string): Temporal.PlainDateTime => {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(value)
  if (!m) throw new Error(`Malformed iCalendar date-time "${value}"`)
  return new Temporal.PlainDateTime(
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  )
}

const splitRule = (rrule: string) =>
  rrule
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

/**
 * Export: floating-local UNTIL becomes a genuine UTC instant.
 *
 * The internal UNTIL is a wall-clock reading in the series' zone (written with a trailing
 * `Z` purely as a carrier). It is resolved through the same DST policy as any occurrence,
 * so a truncation boundary that happens to land in a DST gap behaves consistently with the
 * occurrences around it rather than being special-cased.
 */
export function toIcalSeries(spec: SeriesSpec): IcalSeries {
  const dtstartLocal = Temporal.PlainDateTime.from(spec.dtstartLocal)
  const dtstart = `DTSTART;TZID=${spec.timezone}:${formatLocalCompact(dtstartLocal)}`

  if (spec.rrule === null) {
    return { dtstart, rrule: null, timezone: spec.timezone }
  }

  const parts = splitRule(spec.rrule).map((part) => {
    const m = /^UNTIL=(.+)$/i.exec(part)
    if (!m) return part

    const untilLocal = parseCompact(m[1]!)
    const { zoned } = resolveLocal(untilLocal, spec.timezone)
    return `UNTIL=${formatUtcCompact(zoned.toInstant())}`
  })

  return { dtstart, rrule: `RRULE:${parts.join(';')}`, timezone: spec.timezone }
}

/** Import: a UTC UNTIL becomes a floating local reading in the series' zone. */
export function fromIcalSeries(ical: IcalSeries, durationMinutes: number): SeriesSpec {
  const m = /^DTSTART(?:;TZID=([^:]+))?:(\d{8}T\d{6}Z?)$/.exec(ical.dtstart)
  if (!m) throw new Error(`Malformed DTSTART "${ical.dtstart}"`)

  const timezone = m[1] ?? ical.timezone
  const dtstartLocal = parseCompact(m[2]!)

  if (ical.rrule === null) {
    return {
      dtstartLocal: dtstartLocal.toString(),
      durationMinutes,
      timezone,
      rrule: null,
    }
  }

  const body = ical.rrule.replace(/^RRULE:/i, '')
  const parts = splitRule(body).map((part) => {
    const u = /^UNTIL=(.+)$/i.exec(part)
    if (!u) return part

    const raw = u[1]!
    if (!raw.endsWith('Z')) {
      // A floating or TZID-local UNTIL is already in our internal convention.
      return `UNTIL=${formatLocalCompact(parseCompact(raw))}Z`
    }

    const instant = Temporal.Instant.from(
      parseCompact(raw).toZonedDateTime('UTC').toInstant().toString(),
    )
    const local = instant.toZonedDateTimeISO(timezone).toPlainDateTime()
    return `UNTIL=${formatLocalCompact(local)}Z`
  })

  return {
    dtstartLocal: dtstartLocal.toString(),
    durationMinutes,
    timezone,
    rrule: parts.join(';'),
  }
}

/**
 * Occurrences a strict RFC 5545 §3.3.10 implementation would DROP but CloakCal keeps.
 *
 * ADR 0001 knowingly diverges: §3.3.10 says a generated instance whose local time does not
 * exist "MUST be ignored", while we shift it forward per §3.3.5's DATE-TIME rule. That is
 * a real interoperability seam — the receiving calendar will be missing exactly these
 * instances — so it must be reportable rather than discovered.
 *
 * Export flows use this to warn before sending, per spec §5: never silently flatten
 * behaviour a provider cannot represent.
 */
export function divergentOccurrences(
  occurrences: readonly { occurrenceLocal: string; dst: string }[],
): string[] {
  return occurrences
    .filter((o) => o.dst === 'nonexistent-shifted')
    .map((o) => o.occurrenceLocal)
}
