import { redirect } from 'next/navigation'
import { supabaseServer } from '@/lib/supabase/server'
import { billingEnabled } from '@/server/billing/config'
import { FIXTURE_BILLING, isBillingState } from '@/server/billing/fixture'
import { loadBillingView } from '@/server/billing/view'
import { isDevFixtureEnabled } from '@/server/dev-fixture'
import { loadPlan } from '@/server/plan'
import { DISPLAY_TIMEZONE } from '@/server/range'
import { loadWorkspacePrefs } from '@/server/settings'
import { PlanScreen } from '@/components/settings/plan-screen'

export const metadata = { title: 'Plan · CloakCal' }

/**
 * Never prerendered — reads the signed-in user. Same trap and same fix as /settings,
 * /settings/security and /account: CI has no Supabase variables and dies during prerender,
 * Vercel HAS them and silently bakes an empty session into static HTML. Vercel is the
 * permissive one; a green deploy there is not evidence that a page is dynamic.
 *
 * Worth stating for this page in particular, because most of what it renders is a catalog
 * that does not vary: a page saying "your plan" must still be resolved per account, and a
 * route that already reads an entitlement should not be one that flips from static to
 * dynamic on the day billing lands.
 */
export const dynamic = 'force-dynamic'

export default async function PlanPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const fixtureMode = isDevFixtureEnabled()

  // The demo renders the whole page, honestly: the catalog, plus a note saying there is no
  // account here. That is what puts the price cards, the roadmap rows and their tokens in
  // front of the axe scan and the 44px sweep at all, since every Playwright project runs in
  // fixture mode. loadPlan handles this branch itself and never touches Supabase.
  if (fixtureMode) {
    /*
     * THE BILLING PREVIEW, and it is gated by `fixtureMode` rather than by a check of its own.
     *
     * `isDevFixtureEnabled()` is `NODE_ENV !== 'production'` AND an explicit flag, and Next
     * inlines NODE_ENV at build time, so a production bundle cannot reach this branch at all —
     * the query parameter is not merely ignored in production, the code that reads it is gone.
     * That is deliberately the SAME gate as the fixture calendar and the published seed key
     * rather than a fourth one, per CLAUDE.md: those three move together, and a preview of a
     * purchase screen belongs with them.
     *
     * It is also the only way the billing controls are ever measured. See
     * `server/billing/fixture.ts` for why a flag-on Playwright project cannot substitute.
     */
    const params = await searchParams
    const requested = params.billing
    const state = Array.isArray(requested) ? requested[0] : requested

    return (
      <PlanScreen
        demo
        plan={await loadPlan(null)}
        billing={isBillingState(state) ? FIXTURE_BILLING[state] : null}
        billingPreview={isBillingState(state)}
      />
    )
  }

  const supabase = await supabaseServer()
  const { data } = await supabase.auth.getUser()
  // Middleware already guards this, but a Server Component must not assume middleware ran.
  if (data.user === null) redirect('/sign-in')

  // Which workspace is `loadWorkspacePrefs`'s definition — the oldest active one — rather
  // than a second copy of it here. Two sequential queries on a page nobody opens in a hurry
  // is the cheaper end of that trade.
  const prefs = await loadWorkspacePrefs()
  const plan = await loadPlan(prefs?.workspaceId ?? null)

  /*
   * NULL WHEN BILLING IS OFF, which is every environment today, and the screen's null branch
   * is the page exactly as it was before this feature existed.
   *
   * The timezone is the workspace's, because `loadBillingView` formats the renewal date on the
   * SERVER. Formatting it in the browser would guess the zone from the host and risk a
   * hydration mismatch on the one line in this product that says when money moves.
   */
  const billing = billingEnabled()
    ? await loadBillingView(prefs?.workspaceId ?? null, prefs?.timezone ?? DISPLAY_TIMEZONE)
    : null

  // `demo` passed explicitly, never inferred from an empty email: a signed-in user whose
  // email is null is not demoing, and would otherwise be told they have no account.
  return <PlanScreen demo={false} plan={plan} billing={billing} />
}
