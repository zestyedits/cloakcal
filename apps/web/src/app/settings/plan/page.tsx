import { redirect } from 'next/navigation'
import { supabaseServer } from '@/lib/supabase/server'
import { isDevFixtureEnabled } from '@/server/dev-fixture'
import { loadPlan } from '@/server/plan'
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

export default async function PlanPage() {
  const fixtureMode = isDevFixtureEnabled()

  // The demo renders the whole page, honestly. It is the catalog plus a note saying there is
  // no account here, and it is what puts the badge, the price cards and their tokens in
  // front of the axe scan and the 44px sweep at all — every Playwright project runs in
  // fixture mode. loadPlan handles this branch itself and never touches Supabase.
  if (fixtureMode) return <PlanScreen demo plan={(await loadPlan(null)).planId} />

  const supabase = await supabaseServer()
  const { data } = await supabase.auth.getUser()
  // Middleware already guards this, but a Server Component must not assume middleware ran.
  if (data.user === null) redirect('/sign-in')

  // Which workspace is `loadWorkspacePrefs`'s definition — the oldest active one — rather
  // than a second copy of it here. Two sequential queries on a page nobody opens in a hurry
  // is the cheaper end of that trade.
  const prefs = await loadWorkspacePrefs()
  const plan = await loadPlan(prefs?.workspaceId ?? null)

  // `demo` passed explicitly, never inferred from an empty email: a signed-in user whose
  // email is null is not demoing, and would otherwise be told they have no account.
  return <PlanScreen demo={false} plan={plan.planId} />
}
