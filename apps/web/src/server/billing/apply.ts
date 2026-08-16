import 'server-only'
import type Stripe from 'stripe'
import {
  CLAIM_EVENT,
  LOCK_BY_CUSTOMER,
  LOCK_BY_WORKSPACE,
  UPSERT_SUBSCRIPTION,
  UUID,
} from '@cloakcal/db/billing-queries'
import { type PlanId } from '@/lib/plans'
import { type BillingConfig } from './config'
import { billingDb } from './db'
import { stripeClient } from './stripe'

/**
 * APPLYING ONE STRIPE EVENT TO ONE SUBSCRIPTION ROW, IN ONE TRANSACTION.
 *
 * The order inside `sql.begin` is the design, and `@cloakcal/db/billing-queries` carries the
 * reasoning for each statement. In short:
 *
 *   1. Claim the event id. Zero rows means already applied: commit and do nothing.
 *   2. Resolve the workspace and TAKE THE ROW LOCK.
 *   3. Only then ask Stripe what is true.
 *   4. Upsert.
 *
 * The claim shares the transaction so a failure rolls back both and a retry is a clean re-run.
 * The lock precedes the fetch so two concurrent handlers cannot each read stale state and let
 * the slower one's older snapshot win.
 *
 * THE PAYLOAD IS NEVER TRUSTED FOR STATE. Stripe does not guarantee delivery order, so every
 * branch re-reads the subscription from the API and writes what it says now. The payload is
 * used for exactly two things: which subscription this is about, and — on
 * `checkout.session.completed` only — which workspace, from `client_reference_id`, which our
 * own server put there from an authenticated session.
 */

/** What a handler did, for the log line and for the tests. Never returned to Stripe. */
export type ApplyOutcome =
  | { readonly kind: 'applied'; readonly workspaceId: string; readonly plan: PlanId }
  | { readonly kind: 'duplicate' }
  /** A subscription for a customer we have never seen. Recorded, committed, and logged. */
  | { readonly kind: 'unknown-customer'; readonly customerId: string }
  /** An event type we subscribe to but that carries nothing to apply. */
  | { readonly kind: 'ignored'; readonly reason: string }

const customerIdOf = (value: string | Stripe.Customer | Stripe.DeletedCustomer | null): string | null => {
  if (value === null) return null
  return typeof value === 'string' ? value : value.id
}

/**
 * WHERE THE PERIOD END LIVES, AND WHY IT IS NOT WHERE YOU EXPECT.
 *
 * `billing_mode: flexible` has been the default since API version 2025-09-30, and it moved
 * `current_period_end` OFF the Subscription and ONTO its items. Every guide written before
 * 2025 reads `subscription.current_period_end`, which is now undefined.
 *
 * The failure is silent in both directions: optional in the SDK's types, and nullable by
 * design in migration 0028. A wrong read stores null forever, no constraint fires, and the
 * plan page says "renews —" for the rest of the account's life. Same family as the bytea
 * format mismatch: a quiet wrong answer that only a live object can show you.
 */
function periodEnd(subscription: Stripe.Subscription, config: BillingConfig): string | null {
  const items = subscription.items.data
  const ours = items.find(
    (item) => item.price.id === config.priceMonthly || item.price.id === config.priceAnnual,
  )
  const seconds = (ours ?? items[0])?.current_period_end
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null
  return new Date(seconds * 1000).toISOString()
}

/**
 * THE ENTITLEMENT DECISION, and the only place in the server that makes it.
 *
 * `active` and `trialing` are Pro. Everything else is Free, including `past_due` — which is a
 * deliberate choice and not an oversight. Stripe retries a failed payment for days, and during
 * that window the plan page says "nothing is locked", which is true of the SHIPPED product
 * because no feature is gated yet. The moment one is, this line is where "a failing card keeps
 * its features for the retry window" would be written, and it should be written on purpose
 * with a decision behind it rather than inherited from a default nobody chose.
 */
function planFor(status: Stripe.Subscription.Status): PlanId {
  return status === 'active' || status === 'trialing' ? 'pro' : 'free'
}

export async function applyBillingEvent(
  event: Stripe.Event,
  config: BillingConfig,
): Promise<ApplyOutcome> {
  const stripe = stripeClient(config)
  const sql = billingDb(config.databaseUrl)

  return sql.begin(async (tx): Promise<ApplyOutcome> => {
    // 1. Claim. Inside the transaction, so a rollback un-claims it.
    const claimed = await tx.unsafe(CLAIM_EVENT, [event.id, event.type, event.created])
    if (claimed.length === 0) return { kind: 'duplicate' }

    // 2 and 3, per event type.
    let workspaceId: string | null = null
    let subscriptionId: string | null = null

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object
      // A subscription-mode session with no subscription is a completed one-off payment,
      // which this product does not sell. Recorded and ignored rather than treated as a bug.
      if (session.mode !== 'subscription' || session.subscription === null) {
        return { kind: 'ignored', reason: `checkout mode ${session.mode}` }
      }

      const reference = session.client_reference_id
      /*
       * THE ONE PLACE A WORKSPACE ID ENTERS FROM OUTSIDE, and the only event that carries it.
       * Validated as a uuid before it reaches SQL — not against injection, since these are
       * bind parameters, but against well-formed nonsense: the policies on this table are
       * `using (true)`, so a wrong id writes a plan onto somebody else's account, which ADR
       * 0007 names as the single integrity risk this design leaves standing.
       */
      if (reference === null || !UUID.test(reference)) {
        return { kind: 'ignored', reason: 'checkout session carried no valid workspace id' }
      }

      workspaceId = reference
      subscriptionId =
        typeof session.subscription === 'string' ? session.subscription : session.subscription.id

      // Lock the row if there is one. A first-time buyer has none, and the upsert creates it.
      await tx.unsafe(LOCK_BY_WORKSPACE, [workspaceId])
    } else {
      const subscription = event.data.object as Stripe.Subscription
      subscriptionId = subscription.id
      const customerId = customerIdOf(subscription.customer)
      if (customerId === null) return { kind: 'ignored', reason: 'subscription had no customer' }

      const rows = await tx.unsafe(LOCK_BY_CUSTOMER, [customerId])
      const found = rows[0]?.['workspace_id']

      /*
       * AN UNKNOWN CUSTOMER IS RECORDED, COMMITTED AND RETURNED 200, not retried.
       *
       * Because every branch re-fetches from the API, `checkout.session.completed` creates the
       * row from live state whenever it arrives, so dropping an out-of-order sibling loses
       * nothing. A 5xx would make Stripe retry an event that cannot succeed until its sibling
       * lands, burning retries toward endpoint disablement — and a disabled endpoint is the
       * most silent failure in this whole design.
       *
       * The one case genuinely dropped is a subscription created by hand in the dashboard for
       * a customer we have never seen, which is an operator error the caller's log line names.
       */
      if (typeof found !== 'string') return { kind: 'unknown-customer', customerId }
      workspaceId = found
    }

    // 3. Ask Stripe what is true NOW. The payload may be stale; this cannot be.
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['items.data.price'],
    })

    const customerId = customerIdOf(subscription.customer)
    if (customerId === null) return { kind: 'ignored', reason: 'subscription had no customer' }

    // 4. Write.
    const plan = planFor(subscription.status)
    const written = await tx.unsafe(UPSERT_SUBSCRIPTION, [
      workspaceId,
      plan,
      customerId,
      subscription.id,
      subscription.status,
      periodEnd(subscription, config),
      subscription.cancel_at_period_end,
    ])

    const row = written[0]
    if (row === undefined) {
      // Unreachable while the upsert has a `returning` clause and the role holds INSERT and
      // UPDATE. Throwing rolls the whole transaction back, including the event claim, so
      // Stripe retries rather than the event being silently marked done.
      throw new Error('subscription upsert wrote no row')
    }

    return { kind: 'applied', workspaceId, plan }
  })
}
