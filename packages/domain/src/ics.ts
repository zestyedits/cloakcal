import { toIcalSeries } from './ical.js'
import type { SeriesSpec } from './recurrence.js'

/**
 * The .ics file itself.
 *
 * `ical.ts` next door solves the single hardest sub-problem — DTSTART is local-with-TZID
 * while UNTIL must be UTC and is inclusive — and nothing else. This module is the other
 * half: the component structure, the escaping and the folding that turn one series into a
 * line of a real file. They are separate because the UNTIL conversion is worth reading on
 * its own, and because ADR 0007 once described `ical.ts` as "already written" in a way that
 * read as "export is nearly done".
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT EMIT, AND WHY
 * ---------------------------------------------------------------------------
 *
 * **No VTIMEZONE.** RFC 5545 §3.6.5 says a TZID reference should be accompanied by a
 * VTIMEZONE component defining it. We emit the IANA name and no definition. Google, Apple,
 * Outlook and Thunderbird all resolve IANA TZIDs directly; a strict validator will complain.
 * Generating one means emitting DST transition rules, which is a second implementation of
 * the thing `resolveLocal` already owns, and two implementations of a DST rule disagree
 * eventually — that is the lesson ADR 0001 is built on. Stated here rather than discovered.
 *
 * **No attendee or organiser properties.** Attendees are Cloaked content and land in
 * DESCRIPTION as text if the user exported them. Emitting ATTENDEE would turn an export into
 * something a receiving client may try to send invitations from.
 *
 * DST divergence is reported, not flattened: `divergentOccurrences` in `ical.ts` names the
 * instances a strict §3.3.10 reader will not generate, and the caller is expected to show
 * that rather than let the file silently disagree with the app.
 */

/** One event, already decrypted by the browser. Plaintext — never construct this on a server. */
export interface IcsEvent {
  readonly uid: string
  readonly series: SeriesSpec
  readonly allDay: boolean
  readonly busy: 'busy' | 'free' | 'tentative'
  /** Decrypted content. Any of these may be absent; none may be an empty string. */
  readonly summary?: string | undefined
  readonly location?: string | undefined
  readonly description?: string | undefined
  /** Local wall times of cancelled occurrences, `YYYY-MM-DDTHH:mm:ss`. */
  readonly exdates?: readonly string[] | undefined
}

export interface IcsCalendar {
  readonly events: readonly IcsEvent[]
  /** Stamped by the caller. Passed in rather than read from a clock so output is testable. */
  readonly stamp: string
}

/**
 * RFC 5545 §3.3.11. Backslash first, or every escape this adds gets escaped again.
 *
 * COLON AND QUOTE ARE NOT ESCAPED in TEXT values — a reflex to escape them produces literal
 * backslashes in somebody's event title. Only these four.
 */
const escapeText = (value: string): string =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')

/**
 * §3.1: content lines are folded at 75 OCTETS, not characters.
 *
 * The distinction is the whole point. A title of emoji or CJK hits the octet limit at roughly
 * a quarter of the character count, and folding by `.length` produces a file that looks right
 * in a test written in English and corrupts the first time somebody writes a title in their
 * own language. Folding must also never split a multi-byte codepoint, so this walks
 * codepoints and measures their encoded width.
 */
const foldLine = (line: string): string => {
  const encoder = new TextEncoder()
  const out: string[] = []
  let current = ''
  let octets = 0
  // 75 for the first line; continuations spend one octet on the leading space.
  let limit = 75

  for (const char of line) {
    const width = encoder.encode(char).length
    if (octets + width > limit) {
      out.push(current)
      current = ''
      octets = 0
      limit = 74
    }
    current += char
    octets += width
  }
  out.push(current)
  return out.join('\r\n ')
}

const line = (name: string, value: string): string => foldLine(`${name}:${value}`)

/** `PT1H30M`, and `P1D` for whole days. Never `PT0S`, which some readers treat as invalid. */
const duration = (minutes: number, allDay: boolean): string => {
  if (allDay) {
    const days = Math.max(1, Math.round(minutes / 1440))
    return `P${days}D`
  }
  const total = Math.max(1, Math.round(minutes))
  const hours = Math.floor(total / 60)
  const mins = total % 60
  return `PT${hours > 0 ? `${hours}H` : ''}${mins > 0 || hours === 0 ? `${mins}M` : ''}`
}

/** `2026-05-19T09:00:00` → `20260519T090000`, or `20260519` for a whole day. */
const compact = (local: string, allDay: boolean): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(local)
  if (m === null) throw new Error(`Malformed local date-time "${local}"`)
  const date = `${m[1]}${m[2]}${m[3]}`
  if (allDay) return date
  return `${date}T${m[4] ?? '00'}${m[5] ?? '00'}${m[6] ?? '00'}`
}

const TRANSP: Record<IcsEvent['busy'], string> = {
  busy: 'OPAQUE',
  free: 'TRANSPARENT',
  // No RFC value means "tentative time"; STATUS carries that, and the block still occupies.
  tentative: 'OPAQUE',
}

function toVevent(event: IcsEvent, stamp: string): string[] {
  const { dtstart, rrule } = toIcalSeries(event.series)
  const out: string[] = ['BEGIN:VEVENT']

  out.push(line('UID', event.uid))
  out.push(line('DTSTAMP', stamp))

  if (event.allDay) {
    // A whole-day event is date-valued and carries no zone: 19 May is 19 May wherever it is
    // read, which is the one case where dropping the timezone is the CORRECT reading.
    out.push(line('DTSTART;VALUE=DATE', compact(event.series.dtstartLocal, true)))
  } else {
    out.push(foldLine(dtstart))
  }

  out.push(line('DURATION', duration(event.series.durationMinutes, event.allDay)))

  if (rrule !== null) out.push(foldLine(rrule))

  if (event.exdates !== undefined && event.exdates.length > 0) {
    // Grouped onto one property with a TZID, which is what readers expect; one EXDATE per
    // cancelled occurrence is legal but produces files other clients handle inconsistently.
    const values = event.exdates.map((d) => compact(d, event.allDay)).join(',')
    out.push(
      event.allDay
        ? line('EXDATE;VALUE=DATE', values)
        : line(`EXDATE;TZID=${event.series.timezone}`, values),
    )
  }

  // Absent, never blank. An empty SUMMARY renders as a nameless event in every client, which
  // is worse than no property at all — and mirrors how redaction drops fields rather than
  // blanking them.
  if (event.summary) out.push(line('SUMMARY', escapeText(event.summary)))
  if (event.location) out.push(line('LOCATION', escapeText(event.location)))
  if (event.description) out.push(line('DESCRIPTION', escapeText(event.description)))

  out.push(line('TRANSP', TRANSP[event.busy]))
  if (event.busy === 'tentative') out.push(line('STATUS', 'TENTATIVE'))

  out.push('END:VEVENT')
  return out
}

/**
 * A complete .ics file, CRLF-terminated per §3.1.
 *
 * The trailing CRLF is required: a file whose last line has no terminator is rejected by
 * strict parsers and silently truncated by lenient ones, which is the worse of the two.
 */
export function toIcs(calendar: IcsCalendar): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CloakCal//Calendar Export//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ]

  for (const event of calendar.events) lines.push(...toVevent(event, calendar.stamp))

  lines.push('END:VCALENDAR')
  return `${lines.join('\r\n')}\r\n`
}
