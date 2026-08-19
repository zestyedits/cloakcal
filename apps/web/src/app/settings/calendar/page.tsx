import { redirect } from 'next/navigation'
import { supabaseServer } from '@/lib/supabase/server'
import { isDevFixtureEnabled } from '@/server/dev-fixture'
import { billingEnabled } from '@/server/billing/config'
import { readDemoPrefs } from '@/server/demo-prefs'
import { loadCalendarSettings } from '@/server/settings'
import { DEFAULT_WEEK, describeWeek } from '@/server/availability'
import { CalendarSettingsScreen } from '@/components/settings/calendar-settings-screen'

export const metadata = { title: 'Calendar settings · CloakCal' }

/** Never prerendered — reads the signed-in user. See /settings/privacy for the full trap. */
export const dynamic = 'force-dynamic'

export default async function CalendarSettingsPage() {
  const fixtureMode = isDevFixtureEnabled()

  const dataPromise = fixtureMode ? null : loadCalendarSettings()
  dataPromise?.catch(() => undefined)

  let email = ''
  if (!fixtureMode) {
    const supabase = await supabaseServer()
    const { data } = await supabase.auth.getUser()
    // Middleware already guards this, but a Server Component must not assume middleware ran.
    if (data.user === null) redirect('/sign-in')
    email = data.user.email ?? ''
  }

  const data =
    dataPromise === null
      ? {
          prefs: null,
          calendars: [],
          // The demo shows the example week /settings/availability renders, so this page's
          // one line and the page behind it agree.
          availability: describeWeek(DEFAULT_WEEK),
        }
      : await dataPromise

  // The fixture has no workspace and no session, so everything needing a row to write to
  // stays disabled with honest copy. The DISPLAY preferences are the exception: they come
  // from a cookie instead (lib/demo-prefs.ts), which is what stops this page from being a
  // wall of grey controls when nobody is signed in.
  const prefs = fixtureMode ? await readDemoPrefs() : data.prefs

  return (
    <CalendarSettingsScreen
      email={email}
      fixtureMode={fixtureMode}
      prefs={prefs}
      // Kept apart from the prefs themselves: a demo has no row, and code that needs an id
      // to write with must not be handed a plausible-looking fake one.
      workspaceId={data.prefs?.workspaceId ?? null}
      calendars={data.calendars}
      availability={data.availability}
      billingEnabled={billingEnabled()}
    />
  )
}
