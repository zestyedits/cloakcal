import { Temporal } from '@js-temporal/polyfill'
import { redactPage, type AudienceId } from '@/server/audience'
import { EMPTY_VISIBILITY, audienceIdOf, loadWorkspaceVisibility } from '@/server/visibility'
import { getCalendarPage } from '@/server/events'
import {
  anchorFromParam,
  dateParam,
  dayRange,
  formatDay,
  formatMonth,
  formatRange,
  monthGridRange,
  safeTimezone,
  weekRange,
} from '@/server/range'
import { loadWorkspacePrefs } from '@/server/settings'
import { stepQuery } from '@/lib/calendar-links'
import { supabaseServer } from '@/lib/supabase/server'
import {
  DEMO_WEEK,
  FIXTURE_AUDIENCES,
  FIXTURE_GROUPS,
  FIXTURE_RULES,
  isDevFixtureEnabled,
} from '@/server/dev-fixture'
import { CalendarScreen, type CalendarView, type WeekLink } from '@/components/calendar-screen'
import { Landing } from '@/components/landing'

/**
 * The view/URL contract, in one place:
 *
 *   ?view=  agenda | week | day | month     absent or unknown -> agenda
 *   ?date=  YYYY-MM-DD anchor               absent -> today in the workspace zone
 *   ?week=  accepted as a spelling of date  (old bookmarks; no new link emits it)
 *   ?as=    audience, orthogonal, carried on every link
 *
 * Agenda and week are ONE fetch — the same week, already redacted — and switching between
 * them stays a client toggle (the constraint recorded in calendar-screen.tsx). Day and
 * month need different ranges, so they are server navigations. Steppers move the ANCHOR
 * with PlainDate arithmetic (day ±1 day, week ±7 days, month ±1 month pinned to day 1 so
 * repeated steps cannot drift through short months), then re-range.
 */
const VIEWS: readonly CalendarView[] = ['agenda', 'week', 'day', 'month']

const parseView = (view: string | undefined): CalendarView =>
  VIEWS.includes(view as CalendarView) ? (view as CalendarView) : 'agenda'

/**
 * Server Component. Reads Tier A metadata plus ciphertext from Postgres as the signed-in
 * user, then runs it through the policy engine before anything leaves the server —
 * including for the owner.
 *
 * Nothing here can decrypt. What this component renders into HTML is times, durations and
 * sealed bytes; the words only appear once CloakProvider opens them in the browser.
 */

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{
    as?: string
    view?: string
    week?: string
    date?: string
    landing?: string
  }>
}) {
  const { as, view: viewParam, week, date, landing } = await searchParams
  const view = parseView(viewParam)

  const fixtureMode = isDevFixtureEnabled()

  // Fixture-gated door to the landing page. Every Playwright project runs in fixture
  // mode, where `/` renders the demo calendar and the landing is otherwise reachable by
  // no test at all. Production never takes this branch: isDevFixtureEnabled() is inlined
  // false there, so the session decides, below, as always.
  if (fixtureMode && landing !== undefined) return <Landing />

  let email = ''
  if (!fixtureMode) {
    const supabase = await supabaseServer()
    const { data: userData } = await supabase.auth.getUser()
    // `/` is public now: a visitor with no session gets the landing page, a signed-in
    // user gets their calendar. One address, branched on the session — the landing is
    // what the product looks like from outside, which is also the honest demo of it.
    if (userData.user === null) return <Landing />
    email = userData.user.email ?? ''
  }


  // Workspace prefs frame everything below: the timezone decides which instant range a
  // week spans, week_start decides where it begins. `safeTimezone` degrades a stored zone
  // this runtime cannot use to the default rather than 500ing the calendar.
  const prefs = fixtureMode ? null : await loadWorkspacePrefs()
  const timezone = safeTimezone(prefs?.timezone)
  const weekStart = prefs?.weekStart ?? 0

  // The anchor date every view hangs off. The fixture clamps it: week/agenda stay pinned
  // to the demo week (honouring ?date= there would render an empty grid that looks like a
  // range-maths bug), a day anchor is honoured only inside that week — the day page's
  // week strip needs it — and month pins to May 2026, where the grid honestly shows the
  // demo week's events and thirty-five quiet days, because that is all the fixture has.
  let anchor = anchorFromParam(date ?? week, timezone)
  if (fixtureMode) {
    const demoFirst = Temporal.PlainDate.from(DEMO_WEEK.from.slice(0, 10))
    const inDemoWeek =
      Temporal.PlainDate.compare(anchor, demoFirst) >= 0 &&
      Temporal.PlainDate.compare(anchor, demoFirst.add({ days: 6 })) <= 0
    if (view !== 'day' || !inDemoWeek) anchor = Temporal.PlainDate.from('2026-05-19')
  }

  const range =
    view === 'day'
      ? dayRange(anchor, timezone)
      : view === 'month'
        ? monthGridRange(anchor, timezone, weekStart)
        : fixtureMode
          ? DEMO_WEEK
          : weekRange(anchor.toZonedDateTime({ timeZone: timezone }), weekStart)

  const heading =
    view === 'day'
      ? formatDay(anchor)
      : view === 'month'
        ? formatMonth(anchor)
        : formatRange(range, timezone)

  const calendarPage = await getCalendarPage(range, timezone)

  // Contacts, groups and stored rules. Fixture mode has no workspace behind it, so it gets
  // the fixed pair — owner and public — and no rules, which is the honest thing to show for
  // data that has no owner.
  const visibility =
    calendarPage.workspaceId === null
      ? {
          ...EMPTY_VISIBILITY('fixture'),
          audiences: FIXTURE_AUDIENCES,
          workspaceRules: FIXTURE_RULES,
        }
      : await loadWorkspaceVisibility(calendarPage.workspaceId)

  // `as` is validated against the audiences that actually exist, so a hand-edited URL naming
  // a deleted contact falls back to the owner's view rather than resolving to an audience
  // with no rules — which would look like "this person sees nothing" instead of "no such
  // person" and is the wrong thing to show a user checking their own privacy settings.
  const audience: AudienceId = visibility.audiences.some((a) => audienceIdOf(a) === as)
    ? (as as AudienceId)
    : 'owner'
  // A fixed instant in fixture mode so the demo page is deterministic; request time otherwise.
  const now = fixtureMode ? '2026-05-19T08:00:00-04:00' : new Date().toISOString()
  const page = redactPage(calendarPage, audience, now, {
    workspaceId: visibility.workspaceId,
    workspaceRules: visibility.workspaceRules,
    rulesByEvent: visibility.rulesByEvent,
    // Real membership now loads with the rest of the visibility data. Until it did, real
    // accounts passed an empty map here, so a group rule never applied when previewing an
    // individual who belonged to one — the fixture was the only place group rules worked.
    groupsByContact: fixtureMode ? FIXTURE_GROUPS : visibility.groupsByContact,
    // No rule means hidden. A calendar that defaulted to visible would disclose everything
    // the moment someone was added as a contact, before anyone decided what they should see.
    defaultTimeVis: 'hidden',
  })

  // Steppers move the anchor by one unit of the current view, through the shared builder
  // (lib/calendar-links.ts) so the hotkey layer, the client screen and this page cannot
  // disagree about what a step or Today means — the Today-from-week bug was exactly two
  // builders drifting apart.
  const linkFor = (step: number): WeekLink => ({
    pathname: '/',
    query: stepQuery(dateParam(anchor), view, step, audience),
  })

  // Composing needs a real session and a real workspace, so it is unavailable in fixture
  // mode rather than present-and-broken. The ANCHOR, not range.from: on a month page the
  // range starts in the previous month's grid margin.
  const composeDate = fixtureMode ? undefined : dateParam(anchor)

  return (
    <CalendarScreen
      page={page}
      audiences={visibility.audiences}
      view={view}
      anchorDate={dateParam(anchor)}
      heading={heading}
      previousHref={linkFor(-1)}
      nextHref={linkFor(1)}
      timezone={timezone}
      weekStart={weekStart}
      workspaceRules={visibility.workspaceRules}
      // Owner-only, like version and privacyLevel: rules are Tier A but they are the
      // owner's configuration, and no other audience has a sheet to open with them.
      rulesByEvent={
        audience === 'owner'
          ? Object.fromEntries(visibility.rulesByEvent)
          : {}
      }
      // A Record, not a Map: this crosses the RSC boundary. Ids about ids, nothing more.
      groupsByContact={Object.fromEntries(
        fixtureMode ? FIXTURE_GROUPS : visibility.groupsByContact,
      )}
      email={email}
      composeDate={composeDate}
    />
  )
}
