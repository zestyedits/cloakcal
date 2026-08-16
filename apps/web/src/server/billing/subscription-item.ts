import 'server-only'
import type Stripe from 'stripe'
import type { BillingConfig } from './config'

/**
 * WHICH ITEM ON A STRIPE SUBSCRIPTION IS OURS, AND WHEN ITS PERIOD ENDS. One copy.
 *
 * This predicate existed three times — in `apply.ts`, `view.ts` and
 * `app/api/billing/subscription/route.ts` — and CLAUDE.md names the third copy as a must-fix
 * for reasons this repo has already paid for twice (`calendar-links.ts` and the audience
 * builders both shipped user-facing bugs before their duplication was found).
 *
 * The three had ALREADY DIVERGED on the fallback: two used `items[0]`, the third refused. That
 * divergence is defensible per call site and the predicate is not, so `ourItem` returns the
 * match or null and each caller keeps its own answer for "and if there isn't one".
 *
 * `periodEnd` was duplicated too, carrying the same ten-line comment REWORDED — which is the
 * single most expensive fact in this integration, and two copies means one gets updated.
 */

/** The item priced at one of our two configured prices, or null. */
export function ourItem(
  subscription: Stripe.Subscription,
  config: BillingConfig,
): Stripe.SubscriptionItem | null {
  return (
    subscription.items.data.find(
      (item) => item.price.id === config.priceMonthly || item.price.id === config.priceAnnual,
    ) ?? null
  )
}

/**
 * WHERE THE PERIOD END LIVES, AND WHY IT IS NOT WHERE YOU EXPECT.
 *
 * `billing_mode: flexible` has been the default since API version 2025-09-30, and it moved
 * `current_period_end` OFF the Subscription and ONTO its items. Every guide written before
 * 2025 reads `subscription.current_period_end`, which is now `undefined`.
 *
 * The failure is silent in BOTH directions: the field is optional in the SDK's types, and
 * `subscriptions.current_period_end` is nullable by design in migration 0028. So a wrong read
 * stores null forever, no constraint fires, and the plan page says "renews —" for the rest of
 * the account's life. Same family as the bytea format mismatch: a quiet wrong answer that only
 * a live object can show you.
 */
export function periodEnd(item: Stripe.SubscriptionItem | null): string | null {
  const seconds = item?.current_period_end
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null
  return new Date(seconds * 1000).toISOString()
}

/** Stripe hands back an id or an expanded object, in three places. One unwrap. */
export function customerIdOf(
  value: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined,
): string | null {
  if (value === null || value === undefined) return null
  return typeof value === 'string' ? value : value.id
}
