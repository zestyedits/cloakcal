import { redirect } from 'next/navigation'
import { DEMO_AUDIENCES, redactPage, type AudienceId } from '@/server/audience'
import { getCalendarPage } from '@/server/events'
import { DISPLAY_TIMEZONE, formatRange, rangeFromParam, shiftWeeks, weekParam } from '@/server/range'
import { supabaseServer } from '@/lib/supabase/server'
import { DEMO_WEEK, isDevFixtureEnabled } from '@/server/dev-fixture'
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

  const audience: AudienceId = DEMO_AUDIENCES.some((a) => a.id === as)
    ? (as as AudienceId)
    : 'owner'

  // The fixture is pinned to one week, so honouring ?week= there would render an empty
  // grid and look like a bug in the range maths rather than a property of the fixture.
  const range = fixtureMode ? DEMO_WEEK : rangeFromParam(week, DISPLAY_TIMEZONE)
  const calendarPage = await getCalendarPage(range, DISPLAY_TIMEZONE)
  // A fixed instant in fixture mode so the demo page is deterministic; request time otherwise.
  const now = fixtureMode ? '2026-05-19T08:00:00-04:00' : new Date().toISOString()
  const page = redactPage(calendarPage, audience, now)

  const linkFor = (weeks: number): WeekLink => {
    const shifted = shiftWeeks(range, weeks, DISPLAY_TIMEZONE)
    const query: Record<string, string> = { week: weekParam(shifted, DISPLAY_TIMEZONE) }
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
      audiences={DEMO_AUDIENCES}
      heading={formatRange(range, DISPLAY_TIMEZONE)}
      previousHref={linkFor(-1)}
      nextHref={linkFor(1)}
      timezone={DISPLAY_TIMEZONE}
      email={email}
      composeDate={composeDate}
    />
  )
}
