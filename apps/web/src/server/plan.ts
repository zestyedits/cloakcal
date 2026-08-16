import 'server-only'
import { supabaseServer } from '@/lib/supabase/server'
import { isDevFixtureEnabled } from './dev-fixture'
import { DEFAULT_PLAN_ID, isPlanId, type PlanId } from '@/lib/plans'

/**
 * Which plan an account is on.
 *
 * ITS OWN MODULE, not a function in server/settings.ts, and the separation says the same
 * thing migration 0024 says by using its own table: settings.ts holds PREFERENCES, which are
 * facts the user states about themselves and writes through `set_workspace_prefs`. A plan is
 * a fact stated ABOUT the user, which they must not be able to write. Putting the two
 * loaders side by side would invite exactly the merge the schema exists to prevent.
 *
 * ABSENCE MEANS FREE, and that is the schema's design rather than a fallback papering over
 * a missing row (0024's header explains why there is no bootstrap insert). Every account
 * today has no row, so every account is free, with no backfill and nothing to provision.
 */

/**
 * Where the answer came from. Nothing renders this — it exists so "no row" is a state with a
 * name rather than a `??` buried in a return, and it is the first thing you want to see when
 * a badge is showing the wrong tier.
 */
export type PlanSource = 'stored' | 'default' | 'demo'

export interface AccountPlan {
  readonly planId: PlanId
  readonly source: PlanSource
}

/** The safe answer, and the common one. */
const FREE: AccountPlan = { planId: DEFAULT_PLAN_ID, source: 'default' }

export async function loadPlan(workspaceId: string | null): Promise<AccountPlan> {
  // The fixture branch comes FIRST and never touches supabaseServer(), same as
  // getCalendarPage. CI has no Supabase variables, so reaching for a client here would
  // throw during a build rather than return a plan.
  //
  // The demo's plan is a constant and must never be a cookie. lib/demo-prefs.ts draws its
  // line at display framing — the Tier A facts a real account keeps in plaintext columns —
  // and a plan is the one fact in this product that is not the user's to state. A
  // cookie-backed plan would model precisely the capability 0024 spends a whole table to
  // remove, and would be the pattern whoever wires the real thing copies.
  if (isDevFixtureEnabled()) return { planId: DEFAULT_PLAN_ID, source: 'demo' }

  if (workspaceId === null) return FREE

  /*
   * A BILLING LOOKUP MUST NOT 500 THE CALENDAR, and the try covers the CLIENT as well as the
   * query. Every other loader here throws on error, which is right for them — a failed prefs
   * read renders the week in the wrong timezone, so failing loudly beats rendering a lie.
   * This one degrades, and the degraded answer is the generous one: the worst case is a
   * paying account briefly shown as free, never a free account shown as paid.
   *
   * `supabaseServer()` throws when the environment is not configured, which is a different
   * failure from a query error and would otherwise escape this function and land in the
   * error boundary — making the comment above a claim the code did not keep.
   */
  try {
    const supabase = await supabaseServer()
    const { data, error } = await supabase
      .from('subscriptions')
      .select('plan')
      .eq('workspace_id', workspaceId)
      .maybeSingle<{ plan: string }>()

    if (error !== null || data === null) return FREE

    // Clamped even though a CHECK constraint stands behind it, exactly as loadWorkspacePrefs
    // clamps default_view. A clamp beats trusting a cast.
    return isPlanId(data.plan) ? { planId: data.plan, source: 'stored' } : FREE
  } catch {
    return FREE
  }
}
