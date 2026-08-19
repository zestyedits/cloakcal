import { redirect } from 'next/navigation'
import { supabaseServer } from '@/lib/supabase/server'
import { isDevFixtureEnabled } from '@/server/dev-fixture'
import { billingEnabled } from '@/server/billing/config'
import { loadAvailability, DEFAULT_WEEK } from '@/server/availability'
import { loadWorkspacePrefs } from '@/server/settings'
import { safeTimezone } from '@/server/range'
import { AvailabilityScreen } from '@/components/settings/availability-screen'

export const metadata = { title: 'Availability · CloakCal' }

/**
 * Never prerendered — reads the signed-in user. Same trap and same fix as /settings,
 * /settings/security and /settings/plan: CI has no Supabase variables and dies during
 * prerender, Vercel HAS them and silently bakes an empty session into static HTML. Vercel is
 * the permissive one; a green deploy there is not evidence that a page is dynamic.
 */
export const dynamic = 'force-dynamic'

export default async function AvailabilityPage() {
  const fixtureMode = isDevFixtureEnabled()

  if (fixtureMode) {
    // The demo gets a real-looking week so the page, its controls and its shading are
    // reachable by axe and by the 44px sweep at all. It cannot save: `demo` disables every
    // control, and there is no workspace to write to.
    return (
      <AvailabilityScreen
        demo
        workspaceId={null}
        timezone="America/New_York"
        week={DEFAULT_WEEK}
        billingEnabled={billingEnabled()}
      />
    )
  }

  const supabase = await supabaseServer()
  const { data } = await supabase.auth.getUser()
  // Middleware already guards this, but a Server Component must not assume middleware ran.
  if (data.user === null) redirect('/sign-in')

  const prefs = await loadWorkspacePrefs()
  const week = await loadAvailability(prefs?.workspaceId ?? null)

  return (
    <AvailabilityScreen
      demo={false}
      workspaceId={prefs?.workspaceId ?? null}
      timezone={safeTimezone(prefs?.timezone)}
      week={week}
      billingEnabled={billingEnabled()}
    />
  )
}
