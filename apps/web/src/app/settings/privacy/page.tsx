import { redirect } from 'next/navigation'
import { supabaseServer } from '@/lib/supabase/server'
import { isDevFixtureEnabled } from '@/server/dev-fixture'
import { billingEnabled } from '@/server/billing/config'
import { loadPrivacySettings } from '@/server/settings'
import { PrivacyScreen } from '@/components/settings/privacy-screen'

export const metadata = { title: 'Privacy · CloakCal' }

/**
 * Never prerendered — reads the signed-in user. Same trap and same fix as /settings and
 * /settings/security: CI has no Supabase variables and dies during prerender, Vercel HAS
 * them and silently bakes an empty session into static HTML. Vercel is the permissive one, so
 * a green deploy there is not evidence that a page is dynamic.
 */
export const dynamic = 'force-dynamic'

export default async function PrivacySettingsPage() {
  const fixtureMode = isDevFixtureEnabled()

  const dataPromise = fixtureMode ? null : loadPrivacySettings()
  dataPromise?.catch(() => undefined)

  let email = ''
  if (!fixtureMode) {
    const supabase = await supabaseServer()
    const { data } = await supabase.auth.getUser()
    // Middleware already guards this, but a Server Component must not assume middleware ran.
    if (data.user === null) redirect('/sign-in')
    // The KDF salt, and the reason this page can open a contact name at all.
    email = data.user.email ?? ''
  }

  const data = dataPromise === null ? { prefs: null, visibility: null } : await dataPromise

  return (
    <PrivacyScreen
      email={email}
      fixtureMode={fixtureMode}
      timezone={data.prefs?.timezone ?? 'UTC'}
      workspaceId={data.prefs?.workspaceId ?? null}
      audiences={data.visibility?.audiences ?? []}
      workspaceRules={data.visibility?.workspaceRules ?? []}
      // Maps do not cross the RSC boundary; the membership index flattens here, on the
      // server, where it is still only ids about ids.
      groupsByContact={Object.fromEntries(data.visibility?.groupsByContact ?? [])}
      billingEnabled={billingEnabled()}
    />
  )
}
