import { expandSeries } from '@cloakcal/domain'
import type { VisibilityRule } from '@cloakcal/policy'
import type { AudienceOption } from '@/lib/audiences'
import fixture from './events.fixture.json' with { type: 'json' }
import type { CalendarPage, CalendarRange, OccurrenceView } from './events'
import type { ExportBundle, ExportSeries } from './export'
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

/** The fixture's fixed "now", so demo redactions are deterministic across renders. */
export const FIXTURE_NOW = '2026-05-19T08:00:00-04:00'

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

/**
 * The one event that departs from the workspace baseline, and the reason it exists.
 *
 * A privacy chip now appears only where an event DIFFERS from the workspace baseline (see
 * audience.ts), which means a fixture carrying workspace rules ALONE would render no chip
 * anywhere — the product's central control, absent from the demo and from every browser
 * test that scans it. That is the "a control behind a click is a control nobody tested"
 * trap wearing different clothes: the rule would look implemented and be unexercised.
 *
 * So one fixture event is sealed harder than the rest. Both audiences that can see anything
 * are set to hidden, which takes the widest disclosure to `hidden` against a `limited`
 * baseline, and the row shows a Hidden chip. It is deliberately the MORE private direction:
 * that is the case a real person reaches for, and it is the one where a missing chip would
 * cost them something.
 *
 * The event is Project Review, chosen because nothing asserts on it. Legal Call and Lunch
 * with Sarah are CANARIES in e2e/view-as.spec.ts — the titles that must be absent from a
 * restricted audience's HTML — and hiding a canary from the audience a test expects to see
 * it turns a privacy assertion into a fixture accident.
 */
export const FIXTURE_EVENT_RULES: ReadonlyMap<string, readonly VisibilityRule[]> = new Map([
  [
    'e0000000-0000-4000-8000-000000000005',
    [
      {
        id: 'fixture-event-sarah-hidden',
        scope: 'event',
        audience: 'individual',
        audienceRef: 'sarah',
        groupPriority: null,
        timeVis: 'hidden',
        fields: {},
        revealAt: null,
        expiresAt: null,
      },
      {
        id: 'fixture-event-colleagues-hidden',
        scope: 'event',
        audience: 'group',
        audienceRef: 'colleagues',
        groupPriority: 10,
        timeVis: 'hidden',
        fields: {},
        revealAt: null,
        expiresAt: null,
      },
    ] satisfies readonly VisibilityRule[],
  ],
])

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

/**
 * Returns the fixture expanded against the REQUESTED range, defaulting to the reference
 * week from the brand board. It ignored its range entirely until day and month views
 * existed; now the caller decides — page.tsx still pins week/agenda to DEMO_WEEK, clamps
 * day anchors into it, and pins month to May 2026, so the demo stays deterministic while
 * the other views genuinely render their ranges.
 */
export function getFixturePage(requested: CalendarRange = DEMO_WEEK): CalendarPage {
  assertDevFixtureAllowed()

  const range = requested
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

/**
 * The fixture, as export series rather than a week of occurrences.
 *
 * Exists so the export path has an end-to-end test at all: every Playwright project runs with
 * the dev-unlock flag, so a Postgres-only export would be exercised by nothing. It reads the
 * same `fixture.events` rows `getFixturePage` reads, which is what stops the two drifting into
 * disagreeing about what the demo account contains.
 *
 * The fixture has no recurrence_exceptions, so `exdates` is always empty here. That gap is
 * covered by unit tests on the emitter instead — see packages/domain/src/ics.test.ts.
 */
export function getFixtureExportBundle(): ExportBundle {
  assertDevFixtureAllowed()

  const series: ExportSeries[] = fixture.events.map((event) => {
    const shared = {
      eventId: event.id,
      calendarId: event.calendarId,
      timezone: event.timezone,
      rrule: event.rrule,
      busy: event.busy as ExportSeries['busy'],
      fields: event.fields,
      exdates: [] as readonly string[],
    }

    if (event.allDay !== null) {
      return {
        ...shared,
        allDay: true,
        dtstartLocal: event.allDay.startDate,
        durationMinutes: event.durationMinutes,
      }
    }

    return {
      ...shared,
      allDay: false,
      dtstartLocal: event.dtstartLocal ?? isoLocalFromUtc(event.startUtc, event.timezone),
      durationMinutes: event.durationMinutes,
    }
  })

  return { series, timezone: fixture.timezone }
}
