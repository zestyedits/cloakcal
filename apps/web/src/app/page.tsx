import { redirect } from 'next/navigation'
import { redactPage, type AudienceId } from '@/server/audience'
import { EMPTY_VISIBILITY, audienceIdOf, loadWorkspaceVisibility } from '@/server/visibility'
import { getCalendarPage } from '@/server/events'
import { formatRange, rangeFromParam, safeTimezone, shiftWeeks, weekParam } from '@/server/range'
import { loadWorkspacePrefs } from '@/server/settings'
import { supabaseServer } from '@/lib/supabase/server'
import {
  DEMO_WEEK,
  FIXTURE_AUDIENCES,
  FIXTURE_GROUPS,
  FIXTURE_RULES,
  isDevFixtureEnabled,
} from '@/server/dev-fixture'
import { CalendarScreen, type WeekLink } from '@/components/calendar-screen'

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
  searchParams: Promise<{ as?: string; week?: string }>
}) {
  const { as, week } = await searchParams

  const fixtureMode = isDevFixtureEnabled()

  let email = ''
  if (!fixtureMode) {
    const supabase = await supabaseServer()
    const { data: userData } = await supabase.auth.getUser()
    // Middleware already redirects, but a Server Component must not assume middleware ran —
    // a missed matcher entry would otherwise turn into a null dereference rather than a
    // redirect, and the failure would look like a rendering bug.
    if (userData.user === null) redirect('/sign-in')
    email = userData.user.email ?? ''
  }


  // Workspace prefs frame everything below: the timezone decides which instant range a
  // week spans, week_start decides where it begins. `safeTimezone` degrades a stored zone
  // this runtime cannot use to the default rather than 500ing the calendar.
  const prefs = fixtureMode ? null : await loadWorkspacePrefs()
  const timezone = safeTimezone(prefs?.timezone)
  const weekStart = prefs?.weekStart ?? 0

  // The fixture is pinned to one week, so honouring ?week= there would render an empty
  // grid and look like a bug in the range maths rather than a property of the fixture.
  const range = fixtureMode ? DEMO_WEEK : rangeFromParam(week, timezone, weekStart)
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
    groupsByContact: fixtureMode ? FIXTURE_GROUPS : new Map(),
    // No rule means hidden. A calendar that defaulted to visible would disclose everything
    // the moment someone was added as a contact, before anyone decided what they should see.
    defaultTimeVis: 'hidden',
  })

  const linkFor = (weeks: number): WeekLink => {
    const shifted = shiftWeeks(range, weeks, timezone)
    const query: Record<string, string> = { week: weekParam(shifted, timezone) }
    // The audience is carried across a week step so View As survives navigation; dropping
    // it would silently return a reviewer to the owner's view mid-check.
    if (audience !== 'owner') query['as'] = audience
    return { pathname: '/', query }
  }

  // Composing needs a real session and a real workspace, so it is unavailable in fixture
  // mode rather than present-and-broken.
  const composeDate = fixtureMode ? undefined : range.from.slice(0, 10)

  return (
    <CalendarScreen
      page={page}
      audiences={visibility.audiences}
      heading={formatRange(range, timezone)}
      previousHref={linkFor(-1)}
      nextHref={linkFor(1)}
      timezone={timezone}
      email={email}
      composeDate={composeDate}
    />
  )
}
