import { redirect } from 'next/navigation'
import { supabaseServer } from '@/lib/supabase/server'
import { isDevFixtureEnabled } from '@/server/dev-fixture'
import { billingEnabled } from '@/server/billing/config'
import { loadSettingsSummary } from '@/server/settings'
import { SettingsHub } from '@/components/settings/settings-hub'

export const metadata = { title: 'Settings · CloakCal' }

/**
 * Never prerendered — reads the signed-in user, same trap and same fix as /account: CI has
 * no Supabase variables and would die during prerender; Vercel HAS them and would silently
 * bake an empty session into static HTML. Saying it outright is the fix.
 */
export const dynamic = 'force-dynamic'

/**
 * THE HUB. Four doors, four one-line facts, and no controls at all.
 *
 * This route used to be the whole of settings: seven accordion cards, a four-figure readout
 * band and a roadmap footer, on one page. Four of those seven already held nothing but a
 * paragraph and a link, so the drill-down existed either way — it was simply hidden behind a
 * disclosure triangle that made a signpost look like a control. Every control now has a page,
 * and this one answers the only question a settings home should: what is true about my
 * account right now.
 *
 * The comment this replaced argued against nested routes because "every extra server route is
 * another prerender trap and another e2e surface". Both halves are still true and both are
 * paid for below and in the specs; what changed is the other side of the ledger, once the
 * accordion's cost was counted honestly.
 */
export default async function SettingsPage() {
  const fixtureMode = isDevFixtureEnabled()

  // The summary load starts BEFORE the auth check resolves — both talk to Supabase as the
  // request's cookie-scoped user, neither needs the other, and serialising them was a
  // visible chunk of the "settings freezes" complaint. If the auth check redirects, the
  // discarded promise is caught so a signed-out race cannot become an unhandled rejection.
  const summaryPromise = fixtureMode ? null : loadSettingsSummary()
  summaryPromise?.catch(() => undefined)

  if (!fixtureMode) {
    const supabase = await supabaseServer()
    const { data } = await supabase.auth.getUser()
    // Middleware already guards this, but a Server Component must not assume middleware ran.
    if (data.user === null) redirect('/sign-in')
  }

  /*
   * NO EMAIL, and no CloakProvider. The old page resolved the address because it is the KDF
   * salt and the screen opened ciphertext with it; this one renders four links and reads no
   * sealed byte, so asking for either would be reaching for a key to open nothing.
   */
  return (
    <SettingsHub
      summaries={summaryPromise === null ? null : await summaryPromise}
      fixtureMode={fixtureMode}
      // Resolved here and passed down, so this page and `loading.tsx` — which calls the same
      // function — cannot disagree about how many doors exist.
      billingEnabled={billingEnabled()}
    />
  )
}
