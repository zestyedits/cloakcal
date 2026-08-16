import 'server-only'
import { hasEntitlement, type Feature } from '@/lib/entitlements'
import { type PlanId } from '@/lib/plans'
import { loadSubscription } from './plan'

/**
 * THE GATE. `lib/entitlements.ts` answers "would this plan be allowed"; this answers "is this
 * REQUEST allowed", which is the only one of the two that can refuse anything.
 *
 * It returns a decision instead of throwing. A route handler maps the decision to a status
 * and a slug it already knows how to render; an exception would land in an error boundary as
 * a 500, which tells a user their account is broken when it is merely on the wrong plan.
 * Same reasoning as the RPC hints and `auth/callback`'s error slugs: the caller owns the copy.
 *
 * A DEGRADED READ DENIES HERE, AND THE SAME DEGRADED READ GRANTS FREE IN `loadPlan`. That
 * asymmetry is deliberate and is worth stating rather than leaving to be discovered. One
 * unreadable answer reaches three call sites with three different right responses:
 *
 *   - rendering a badge      -> be generous. Free for one render is a small lie in a sidebar.
 *   - granting a capability  -> deny. A gate that fails open is not a gate.
 *   - offering a purchase    -> draw nothing. Charging someone twice is the worst outcome.
 *
 * `loadPlan` takes the first, this function takes the second, and `SubscriptionRow.degraded`
 * is what lets the plan screen take the third.
 *
 * NOTHING CALLS THIS YET, and that is the honest state rather than an oversight. Every
 * feature in the map is unbuilt. `entitlements.server.test.ts` sweeps every route handler and
 * requires each one to either call this or sit in an allowlist with a written reason, so the
 * first gated feature is one line here and a deleted allowlist entry there.
 */

export type EntitlementDecision =
  | { readonly allowed: true; readonly plan: PlanId }
  | { readonly allowed: false; readonly reason: 'plan' | 'unreadable' | 'no-workspace' }

export async function requireEntitlement(
  workspaceId: string | null,
  feature: Feature,
): Promise<EntitlementDecision> {
  if (workspaceId === null) return { allowed: false, reason: 'no-workspace' }

  const row = await loadSubscription(workspaceId)
  if (row.degraded) return { allowed: false, reason: 'unreadable' }

  return hasEntitlement(row.plan, feature)
    ? { allowed: true, plan: row.plan }
    : { allowed: false, reason: 'plan' }
}
