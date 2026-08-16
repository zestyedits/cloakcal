import { Temporal } from '@js-temporal/polyfill'
import type { AudienceId } from '@/server/audience'
import { resolveAndRedact } from '@/server/redaction'
import { getCalendarPage } from '@/server/events'
import { loadPlan } from '@/server/plan'
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
import { loadAvailability } from '@/server/availability'
import { resolveHolidays } from '@/server/holidays'
import { loadWorkspacePrefs, type CalendarPrefs } from '@/server/settings'
import { readDemoPrefs } from '@/server/demo-prefs'
import { stepQuery } from '@/lib/calendar-links'
import { isCalendarView } from '@/lib/calendar-views'
import { supabaseServer } from '@/lib/supabase/server'
import { DEMO_WEEK, isDevFixtureEnabled } from '@/server/dev-fixture'
import { CalendarScreen, type CalendarView, type WeekLink } from '@/components/calendar-screen'
import { Landing } from '@/components/landing'

/**
 * The view/URL contract, in one place:
 *
 *   ?view=  agenda | week | day | month     absent or unknown -> the stored default_view,
 *                                           from the workspace row or the demo cookie
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
const parseView = (view: string | undefined, fallback: CalendarView = 'agenda'): CalendarView =>
  isCalendarView(view) ? view : fallback

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


  // Prefs frame everything below: the timezone decides which instant range a week spans,
  // week_start decides where it begins. `safeTimezone` degrades a stored zone this runtime
  // cannot use to the default rather than 500ing the calendar.
  //
  // Two sources, one shape. A real account reads its `workspaces` row; the demo reads a
  // cookie (see lib/demo-prefs.ts), because otherwise the fixture had no prefs at all and
  // every preference below silently collapsed to its fallback — which is exactly how
  // "opens on the view I chose" came to look unbuilt when tried without signing in.
  const workspacePrefs = fixtureMode ? null : await loadWorkspacePrefs()
  const prefs: CalendarPrefs | null = fixtureMode ? await readDemoPrefs() : workspacePrefs
  const timezone = safeTimezone(prefs?.timezone)
  const weekStart = prefs?.weekStart ?? 0

  // Started HERE and awaited at the very bottom, so it overlaps the events fetch entirely
  // rather than sitting in front of it. The plan is a badge, not framing: unlike the prefs
  // above, nothing below needs it to decide what to query.
  //
  // No `.catch()` guard, unlike /settings' data promise, and the difference is real rather
  // than an oversight: loadPlan cannot reject. Everything after its fixture branch is inside
  // its own try/catch, including the supabaseServer() construction, so there is no rejection
  // for an early return to leave loose.
  const planPromise = loadPlan(workspacePrefs?.workspaceId ?? null)

  // The URL always wins so links stay shareable; the STORED default only fills the
  // absent-or-unknown case. Resolved here rather than at the top because the fallback is
  // a preference the server has to read first.
  const view = parseView(viewParam, prefs?.defaultView ?? 'agenda')

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

  // Public dates, computed from a rule table — no query, no network, nothing about this
  // user. Anchored rather than ranged because four surfaces draw from it and they do not
  // share one window: the mini month shows a whole month while the day view shows one day.
  // See server/holidays.ts for why this is server-side and why that costs no privacy.
  const holidays = resolveHolidays(prefs?.holidayRegion ?? 'auto', timezone, dateParam(anchor))

  // Started here and awaited with the events fetch. Like the plan, it cannot reject: its
  // whole body is inside a try/catch, and the degraded answer is "no shading", which is the
  // same state a brand-new account is in and the UI therefore already handles.
  const availabilityPromise = loadAvailability(workspacePrefs?.workspaceId ?? null)

  const calendarPage = await getCalendarPage(range, timezone)

  // Audience resolution and redaction live in ONE function shared with the People
  // preview, because the preview must show exactly what this page would serve that
  // audience — sameness by construction, not by transcription.
  const { visibility, audience, page, groupsByContact } = await resolveAndRedact(
    calendarPage,
    as as AudienceId,
    fixtureMode,
  )

  // Steppers move the anchor by one unit of the current view, through the shared builder
  // (lib/calendar-links.ts) so the hotkey layer, the client screen and this page cannot
  // disagree about what a step or Today means — the Today-from-week bug was exactly two
  // builders drifting apart.
  const linkFor = (step: number): WeekLink => ({
    pathname: '/',
    query: stepQuery(dateParam(anchor), view, step, audience),
  })

  // The ANCHOR, not range.from: on a month page the range starts in the previous month's
  // grid margin. The fixture now composes too — as a demo that structurally cannot write
  // (NewEvent.demo skips the workspace lookup and refuses the submit) — because a compose
  // sheet no test could ever open is how the first sheet shipped without a focus trap.
  // demoMode is what keeps the actual WRITE doors (add calendar, seed samples) closed.
  const composeDate = dateParam(anchor)

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
      // The map the engine redacted with, from resolveAndRedact — never re-derived here.
      groupsByContact={Object.fromEntries(groupsByContact)}
      email={email}
      composeDate={composeDate}
      demoMode={fixtureMode}
      // The stored opt-in, default off (WCAG 2.1.4 route one). This used to read
      // `?? fixtureMode` — a special case for one preference that no other preference got,
      // because the fixture had no write path to flip one. It has one now, so the demo
      // models an opted-in user by DEFAULTING to on (DEMO_DEFAULT_PREFS) and the special
      // case is gone. The OFF default itself is pinned where it lives: the 0022 column
      // default and its db test.
      hotkeysEnabled={prefs?.keyboardShortcuts ?? false}
      defaultView={prefs?.defaultView ?? 'agenda'}
      // Only a real workspace can take a preference write; the demo writes its cookie
      // instead and needs no id, which is why these are two props and not one.
      workspaceId={workspacePrefs?.workspaceId ?? null}
      // The tier, for the badge in the account cluster. That cluster only renders with a
      // real session, so the demo never shows one: a fixture has no account and therefore
      // no plan, and inventing a Free chip for it would be the same dishonesty as storing
      // a plan in a cookie.
      plan={await planPromise}
      // Public holidays for the window around the anchor, plus the tri-state behind them so
      // the sidebar row can say "Off" versus "on, but your timezone maps to no region we
      // ship" — two states that look identical if only the resolved region crosses over.
      holidays={holidays.byDate}
      holidayRegion={holidays.region}
      holidayPreference={prefs?.holidayRegion ?? 'auto'}
      // Shades the hours outside your working day on the week and day grids. Owner only:
      // it is the owner's own schedule, and a restricted audience previewing the calendar
      // has no business being told when this person works.
      availability={audience === 'owner' ? await availabilityPromise : {}}
    />
  )
}
