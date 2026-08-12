import { expandSeries } from '@cloakcal/domain'
import type { VisibilityRule } from '@cloakcal/policy'
import type { AudienceOption } from '@/lib/audiences'
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

/**
 * Audiences and rules for the fixture.
 *
 * These ARE the old `DEMO_AUDIENCES` and `WORKSPACE_RULES`, moved out of
 * `server/audience.ts` and behind the same gate as the fixture events. That is the point of
 * the move: in production those constants made View As demonstrate the engine rather than
 * control it, but the end-to-end privacy suite genuinely needs a restricted audience to
 * assert against — the tests that check a withheld title is absent from the HTML are
 * meaningless without someone to withhold it from.
 *
 * So the demo data stays, in the one place that is honestly labelled demo data, and cannot
 * reach a production build. Real contacts come from the database.
 *
 * The ids are the literals the e2e suite navigates to (`?as=contact:sarah`), not uuids.
 * Nothing validates them as uuids on this path because nothing here touches Postgres.
 */
export const FIXTURE_AUDIENCES: readonly AudienceOption[] = [
  { id: 'owner', kind: 'owner' },
  { id: 'sarah', kind: 'individual' },
  { id: 'alex', kind: 'individual' },
  { id: 'public', kind: 'public' },
]

/**
 * Chosen to exercise the interesting paths rather than to flatter the engine: Sarah gets a
 * title and an exact time, colleagues get busy-only, and the public gets nothing because no
 * rule mentions them.
 */
export const FIXTURE_RULES: readonly VisibilityRule[] = [
  {
    id: 'fixture-sarah-limited',
    scope: 'workspace',
    audience: 'individual',
    audienceRef: 'sarah',
    groupPriority: null,
    timeVis: 'exact',
    fields: { title: 'visible' },
    revealAt: null,
    expiresAt: null,
  },
  {
    id: 'fixture-colleagues-busy',
    scope: 'workspace',
    audience: 'group',
    audienceRef: 'colleagues',
    groupPriority: 10,
    timeVis: 'busy',
    fields: {},
    revealAt: null,
    expiresAt: null,
  },
]

/** Alex is the colleague; Sarah is not, so the two rules above land differently. */
export const FIXTURE_GROUPS = new Map<string, readonly string[]>([['alex', ['colleagues']]])

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
          // The fixture is read-only — there is no Postgres row behind it to delete, so the
          // version is a placeholder rather than a real row version.
          version: 1,
          recurring: event.rrule !== null,
          series: null,
        })
      }
      continue
    }

    // Hoisted so the occurrence and its series spec cannot drift, and so the union of
    // fixture row shapes is narrowed once rather than inside a conditional.
    const spec = {
      // Some fixture rows predate the local anchor and carry only a UTC instant.
      dtstartLocal: event.dtstartLocal ?? isoLocalFromUtc(event.startUtc, event.timezone),
      durationMinutes: event.durationMinutes,
      timezone: event.timezone,
      rrule: event.rrule,
    }

    for (const occurrence of expandSeries(spec, range)) {
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
        version: 1,
        recurring: event.rrule !== null,
        series:
          spec.rrule === null
            ? null
            : { dtstartLocal: spec.dtstartLocal, rrule: spec.rrule, durationMinutes: spec.durationMinutes },
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
    // No workspace behind the fixture, so no contacts and no stored rules to load. The page
    // falls back to owner-and-public, which is the honest thing to show for data that has
    // no owner.
    workspaceId: null,
  }
}
