import { expandSeries, type Occurrence } from '@cloakcal/domain'
import fixture from './events.fixture.json' with { type: 'json' }

/**
 * The server read path.
 *
 * Returns Tier A metadata and CIPHERTEXT. Nothing here can decrypt, and nothing here is
 * permitted to import @cloakcal/crypto or @cloakcal/cloak-store — enforced statically by
 * server-boundary.leak.test.ts.
 *
 * Recurrence expansion happens here on purpose: occurrence times are Tier A, the server
 * already knows them (plan D1), and expanding once server-side beats shipping an rrule
 * engine's worth of work to every client for every view change.
 *
 * M1 reads a committed fixture. The Supabase-backed version replaces this module's body
 * and nothing else: the shape below is exactly what the real query returns.
 */

export interface CiphertextField {
  readonly fieldName: string
  /** Hex. The client converts to bytes; the server never interprets them. */
  readonly ciphertext: string
  readonly nonce: string
  readonly alg: string
  readonly keyVersion: number
}

export interface CalendarMeta {
  readonly id: string
  readonly colorToken: string
  readonly fields: readonly CiphertextField[]
}

/** One resolved occurrence. Times are Tier A; everything readable is still sealed. */
export interface OccurrenceView {
  readonly eventId: string
  readonly calendarId: string
  readonly occurrenceLocal: string
  readonly start: string
  readonly end: string
  readonly startInstant: string
  readonly allDay: boolean
  readonly busy: 'busy' | 'free' | 'tentative'
  readonly dst: Occurrence['dst']
  readonly fields: readonly CiphertextField[]
}

export interface CalendarPage {
  readonly timezone: string
  readonly from: string
  readonly to: string
  readonly calendars: readonly CalendarMeta[]
  readonly occurrences: readonly OccurrenceView[]
}

/** The reference week from the brand board, so the app and the board show the same data. */
export const DEMO_WEEK = {
  from: '2026-05-18T00:00:00-04:00',
  to: '2026-05-25T00:00:00-04:00',
} as const

export function getCalendarPage(range: { from: string; to: string } = DEMO_WEEK): CalendarPage {
  const occurrences: OccurrenceView[] = []

  for (const event of fixture.events) {
    if (event.allDay !== null) {
      // All-day events are date-only and never resolved through a timezone (ADR 0001).
      const startDate = event.allDay.startDate
      if (startDate >= range.from.slice(0, 10) && startDate < range.to.slice(0, 10)) {
        occurrences.push({
          eventId: event.id,
          calendarId: event.calendarId,
          occurrenceLocal: startDate,
          start: startDate,
          end: event.allDay.endDate,
          startInstant: `${startDate}T00:00:00Z`,
          allDay: true,
          busy: event.busy as OccurrenceView['busy'],
          dst: 'none',
          fields: event.fields,
        })
      }
      continue
    }

    const expanded = expandSeries(
      {
        dtstartLocal: event.dtstartLocal ?? isoLocalFromUtc(event.startUtc, event.timezone),
        durationMinutes: event.durationMinutes,
        timezone: event.timezone,
        rrule: event.rrule,
      },
      range,
    )

    for (const occurrence of expanded) {
      occurrences.push({
        eventId: event.id,
        calendarId: event.calendarId,
        occurrenceLocal: occurrence.occurrenceLocal,
        start: occurrence.start,
        end: occurrence.end,
        startInstant: occurrence.startInstant,
        allDay: false,
        busy: event.busy as OccurrenceView['busy'],
        dst: occurrence.dst,
        fields: event.fields,
      })
    }
  }

  occurrences.sort((a, b) => a.startInstant.localeCompare(b.startInstant))

  return {
    timezone: fixture.timezone,
    from: range.from,
    to: range.to,
    calendars: fixture.calendars,
    occurrences,
  }
}

/**
 * Render a UTC instant as local wall time in a zone, without constructing a Date.
 *
 * Intl is used rather than Date arithmetic for the same reason the CRUD read path asks
 * Postgres for text: the host machine's timezone must never influence the result.
 */
function isoLocalFromUtc(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(instant))

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`
}
