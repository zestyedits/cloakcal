import { redirect } from 'next/navigation'
import { supabaseServer } from '@/lib/supabase/server'
import { isDevFixtureEnabled } from '@/server/dev-fixture'
import { readDemoPrefs } from '@/server/demo-prefs'
import { loadSettingsData } from '@/server/settings'
import { SettingsScreen, type SettingsProps } from '@/components/settings/settings-screen'

export const metadata = { title: 'Settings · CloakCal' }

/**
 * Never prerendered — reads the signed-in user, same trap and same fix as /account: CI has
 * no Supabase variables and would die during prerender; Vercel HAS them and would silently
 * bake an empty session into static HTML. Saying it outright is the fix.
 */
export const dynamic = 'force-dynamic'

/**
 * One route, one scrollable page, anchored sections. Not nested routes: every extra server
 * route is another prerender trap and another e2e surface, and a two-level drill-down for
 * every toggle is hostile at 390px.
 *
 * The email is resolved here because it is the KDF salt (see /account); everything else the
 * screen needs comes from one load. Nothing decrypted exists on this side of the boundary —
 * calendar names, contact names and group labels all travel as ciphertext.
 */
export default async function SettingsPage() {
  const fixtureMode = isDevFixtureEnabled()

  // The data load starts BEFORE the auth check resolves — both talk to Supabase as the
  // request's cookie-scoped user, neither needs the other, and serialising them was a
  // visible chunk of the "settings freezes" complaint. If the auth check redirects, the
  // discarded promise is caught so a signed-out race cannot become an unhandled rejection.
  const dataPromise = fixtureMode ? null : loadSettingsData()
  dataPromise?.catch(() => undefined)

  let email = ''
  if (!fixtureMode) {
    const supabase = await supabaseServer()
    const { data } = await supabase.auth.getUser()
    // Middleware already guards this, but a Server Component must not assume middleware ran.
    if (data.user === null) redirect('/sign-in')
    email = data.user.email ?? ''
  }

  // The fixture has no workspace and no session, so everything that needs a row to write
  // to stays disabled with honest copy. The four DISPLAY preferences are the exception:
  // they come from a cookie instead (see lib/demo-prefs.ts), which is what stops this page
  // from being a wall of grey controls when nobody is signed in.
  const data =
    dataPromise === null
      ? { prefs: null, calendars: [], visibility: null, devices: [] }
      : await dataPromise

  const prefs = fixtureMode ? await readDemoPrefs() : data.prefs

  // Maps do not cross the RSC boundary; the membership indexes flatten to plain records
  // here, on the server, where they are still only ids about ids.
  const props: SettingsProps = {
    email,
    fixtureMode,
    prefs,
    // Kept apart from the prefs themselves: a demo has no row, and code that needs an id
    // to write with must not be handed a plausible-looking fake one.
    workspaceId: data.prefs?.workspaceId ?? null,
    calendars: data.calendars,
    devices: data.devices,
    audiences: data.visibility?.audiences ?? [],
    workspaceRules: data.visibility?.workspaceRules ?? [],
    groupsByContact: Object.fromEntries(data.visibility?.groupsByContact ?? []),
  }

  return <SettingsScreen {...props} />
}
