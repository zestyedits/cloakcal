import { expandSeries } from '@cloakcal/domain'
import fixture from './events.fixture.json' with { type: 'json' }
import type { CalendarPage, CalendarRange, OccurrenceView } from './events'
import { isoLocalFromUtc } from './local-time'

/**
 * The committed fixture, and the one gate that reaches it.
 *
 * WHY THIS STILL EXISTS AFTER THE REAL READ PATH LANDED. The end-to-end suite has to be
 * deterministic, offline, and free of a live account. Pointing Playwright at Supabase would
 * make the privacy tests — the ones that assert a withheld title is absent from the HTML —
 * depend on network conditions and on seed data staying put. A test that goes yellow for
 * unrelated reasons stops being read, and these are the tests that must be read.
 *
 * WHY IT IS NOT A PRODUCT PATH. The gate below is the same shape as the dev key's: NODE_ENV
 * must not be production, and the flag must be explicitly set. Next inlines NODE_ENV at
 * build time, so a production bundle cannot reach this code even if someone sets the
 * variable on the server. One flag governs both the fixture and the key, so there is no
 * configuration in which the app serves fixture data it cannot decrypt, or reaches for the
 * dev key against real rows.
 *
 * The fixture holds real AES-256-GCM ciphertext under a published seed. Nothing in it is
 * protected, and treating it as though it were would be worse than saying so.
 */

export const DEMO_WEEK: CalendarRange = {
  from: '2026-05-18T00:00:00-04:00',
  to: '2026-05-25T00:00:00-04:00',
}

export function isDevFixtureEnabled(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.NEXT_PUBLIC_CLOAKCAL_DEV_UNLOCK === '1'
  )
}

export function assertDevFixtureAllowed(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'The development fixture is not available in a production build. Real data comes from ' +
        'Supabase, and there is no configuration that changes that.',
    )
  }
}

/** Ignores the requested range and always returns the reference week from the brand board. */
export function getFixturePage(): CalendarPage {
  assertDevFixtureAllowed()

  const range = DEMO_WEEK
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

    for (const occurrence of expandSeries(
      {
        // Some fixture rows predate the local anchor and carry only a UTC instant.
        dtstartLocal: event.dtstartLocal ?? isoLocalFromUtc(event.startUtc, event.timezone),
        durationMinutes: event.durationMinutes,
        timezone: event.timezone,
        rrule: event.rrule,
      },
      range,
    )) {
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
