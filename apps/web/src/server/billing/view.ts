import 'server-only'
import type Stripe from 'stripe'
import { formatMoney, type PlanCadence, type PlanId } from '@/lib/plans'
import { loadSubscription, type SubscriptionRow } from '../plan'
import { billingConfig } from './config'
import { stripeClient } from './stripe'
import { ourItem, periodEnd } from './subscription-item'

/**
 * EVERYTHING THE PLAN SCREEN NEEDS, AND A HARD LINE THROUGH THE MIDDLE OF IT.
 *
 * > Entitlement comes from `subscriptions.plan` and nothing else, ever. The renewal date, the
 * > cadence, the card and the invoices are read from Stripe at render time and grant nothing.
 *
 * That line is ADR 0009 §1 and it is the one a future reader is most likely to be tempted to
 * cross. The temptation arrives on the day a webhook is late: it would be one line to grant
 * Pro from the Stripe response sitting right here. Doing it turns the paywall into an outbound
 * HTTP call — it fails OPEN when Stripe is slow, it makes the entitlement unauditable from the
 * database, and it puts a third party's uptime in the authorisation path. `plan` below is
 * copied straight off our own row and is never touched by anything in this file.
 *
 * THE SPLIT ALSO SOLVES A REAL PROBLEM, which is why it is not merely principled. Only
 * `billing_writer` may write `subscriptions`, and it only runs in the webhook, so an in-app
 * cancel cannot update our own row. Reading the display facts live means `router.refresh()`
 * after a cancel shows the truth immediately: no optimistic state, nothing to reconcile, and
 * no flicker back to the old value a second later when the row catches up.
 *
 * WHEN STRIPE CANNOT BE REACHED WE SAY SO. `stale` falls back to our own columns and the
 * screen prints a line admitting the details may be a few minutes behind, rather than
 * presenting older columns as if they were live.
 */

/**
 * Seven states, because the copy differs in all seven and an exhaustive switch over this
 * union is what stops an eighth arriving without somebody writing words for it.
 */
export type BillingState =
  /** Free, and nothing was ever bought. The normal state of every account today. */
  | 'none'
  /** Free, but a provider customer exists: they had Pro once and can buy again. */
  | 'lapsed'
  /** Pro with NO provider subscription. Granted by hand: no card, no renewal, nothing to cancel. */
  | 'granted'
  | 'active'
  /** Pro, paid for, and set not to renew. */
  | 'cancelling'
  /** Pro, last payment failed, the processor is retrying. Nothing is locked. */
  | 'past_due'
  /** The local read failed. Draw no purchase control and no management control. */
  | 'unreadable'

export interface BillingInvoice {
  readonly id: string
  /** Already formatted in the workspace timezone. */
  readonly date: string
  /** Already formatted with its own currency, which need not be the catalog's. */
  readonly amount: string
  readonly paid: boolean
  /** Stripe's hosted invoice page. Null when Stripe did not give us one. */
  readonly url: string | null
}

export interface BillingView {
  readonly state: BillingState
  /** From our column. The entitlement. Never from Stripe. */
  readonly plan: PlanId
  readonly cadence: PlanCadence | null
  /** Formatted on the server, in the workspace timezone. */
  readonly renewsOn: string | null
  readonly cancelAtPeriodEnd: boolean
  /**
   * EVERY MANAGEMENT CONTROL KEYS OFF THIS, never off `plan === 'pro'`. A granted account has
   * Pro and nothing to manage, and a Cancel button that posts a null id 500s on an account
   * that never paid.
   */
  readonly subscriptionId: string | null
  readonly cardSummary: string | null
  readonly invoices: readonly BillingInvoice[]
  /** True when these facts came from our columns because Stripe could not be reached. */
  readonly stale: boolean
  readonly mode: 'test'
}

/**
 * Stripe statuses that mean "paid for, working". Everything else on a Pro row is treated as a
 * payment problem, which is the safe direction: the screen offers to fix a card rather than
 * claiming all is well. `incomplete_expired` and `unpaid` are included in the problem side
 * deliberately — they are terminal, and the copy for them is the same "update your card"
 * instruction that gets a customer unstuck fastest.
 */
const HEALTHY = new Set(['active', 'trialing'])

/**
 * The three facts that decide WHICH Pro state this is, when Stripe answered.
 *
 * WHY IT IS SAFE TO TAKE THESE FROM STRIPE, given the rule at the top of this file. `active`,
 * `cancelling` and `past_due` all mean the same thing to the entitlement: `plan === 'pro'`,
 * which came from our own row and is the only reason any of the three is reachable. Choosing
 * between them grants nothing — the widest of them is still Pro and the narrowest is still
 * Pro. The free/pro decision itself never consults this.
 *
 * IT ALSO HAS TO WORK THIS WAY, or the screen contradicts itself. Only `billing_writer` writes
 * our row, and it only runs in the webhook, so between an in-app cancel and the webhook
 * landing our column says `cancel_at_period_end = false` while Stripe says true. Deriving the
 * state from the row and the flag from Stripe would print "renews on 3 March" above a banner
 * saying it will not renew.
 */
export interface LiveSubscriptionFacts {
  readonly cancelAtPeriodEnd: boolean
  readonly status: string
}

export function billingState(row: SubscriptionRow, live?: LiveSubscriptionFacts): BillingState {
  if (row.degraded) return 'unreadable'

  if (row.plan === 'pro') {
    if (row.providerSubscriptionId === null) return 'granted'

    const cancelling = live?.cancelAtPeriodEnd ?? row.cancelAtPeriodEnd
    const status = live?.status ?? row.providerStatus

    // A payment problem outranks a pending cancellation. Someone whose card is failing and who
    // has also cancelled needs the card message: it is the one with an action attached, and
    // "you keep Pro until 3 March" is a promise we cannot make while a renewal is bouncing.
    //
    // A null status on a row that HAS a subscription id means the webhook wrote a partial row,
    // which is a payment we cannot vouch for. Treat it as a problem, not as active.
    if (status === null || !HEALTHY.has(status)) return 'past_due'
    if (cancelling) return 'cancelling'
    return 'active'
  }

  return row.providerCustomerId === null ? 'none' : 'lapsed'
}

/**
 * A date, in the workspace's timezone, spelled out.
 *
 * FORMATTED ON THE SERVER on purpose. The plan page already loads `loadWorkspacePrefs()`, so
 * the timezone is in hand; formatting in the client would guess it from the browser and risk a
 * hydration mismatch on the one line in this product that says when money moves.
 *
 * `'en-GB'` gives "3 March 2026" rather than "March 3, 2026", which is what every other date
 * in this app already reads like.
 */
function formatDate(instant: string | null, timezone: string): string | null {
  if (instant === null) return null
  const parsed = new Date(instant)
  if (Number.isNaN(parsed.getTime())) return null
  try {
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: timezone,
    }).format(parsed)
  } catch {
    // An unknown timezone throws rather than falling back, and a billing page must not 500
    // over a date. UTC is wrong by at most a day and says something rather than nothing.
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(parsed)
  }
}



function cadenceOf(item: Stripe.SubscriptionItem | null): PlanCadence | null {
  const interval = item?.price.recurring?.interval
  if (interval === 'month') return 'monthly'
  if (interval === 'year') return 'annual'
  // 'day' and 'week' exist in Stripe's enum and are not prices this product creates. Null
  // rather than a guess: the screen omits the cadence line instead of naming a wrong one.
  return null
}

function cardOf(subscription: Stripe.Subscription): string | null {
  const method = subscription.default_payment_method
  if (method === null || method === undefined || typeof method === 'string') return null
  const card = method.card
  if (card === undefined || card === null) return null
  const brand = card.brand.charAt(0).toUpperCase() + card.brand.slice(1)
  return `${brand} ending ${card.last4}`
}

/** What the screen shows when a read told us nothing. Free, no controls, honest about it. */
function unreadableView(): BillingView {
  return {
    state: 'unreadable',
    plan: 'free',
    cadence: null,
    renewsOn: null,
    cancelAtPeriodEnd: false,
    subscriptionId: null,
    cardSummary: null,
    invoices: [],
    stale: false,
    mode: 'test',
  }
}

/** Our own columns, with nothing added from Stripe. */
function localView(row: SubscriptionRow, timezone: string, stale: boolean): BillingView {
  return {
    state: billingState(row),
    plan: row.plan,
    // No cadence column exists and one is deliberately not being added: the fact lives on the
    // Stripe price and a second copy would be a second thing to keep in step.
    cadence: null,
    renewsOn: formatDate(row.currentPeriodEnd, timezone),
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    subscriptionId: row.providerSubscriptionId,
    cardSummary: null,
    invoices: [],
    stale,
    mode: 'test',
  }
}

/**
 * Everything the plan screen renders, for a real account.
 *
 * NEVER THROWS. Same contract as `loadPlan`, and for a stronger reason: this one reaches a
 * third party over the network, so its worst day is somebody else's outage. Every failure path
 * lands on our own columns with `stale: true`, and the screen says the details may be behind.
 */
export async function loadBillingView(
  workspaceId: string | null,
  timezone: string,
): Promise<BillingView> {
  const row = await loadSubscription(workspaceId)
  if (row.degraded) return unreadableView()

  const config = billingConfig()
  // Nothing to fetch: either billing is not configured, or this account has never bought
  // anything. Not stale — there is no fresher answer that we failed to get.
  if (config === null || row.providerSubscriptionId === null) {
    return localView(row, timezone, false)
  }

  try {
    const stripe = stripeClient(config)
    const subscription = await stripe.subscriptions.retrieve(row.providerSubscriptionId, {
      expand: ['items.data.price', 'default_payment_method'],
    })

    // Falls back to the first item: a subscription carrying prices we do not recognise is
    // still a subscription, and showing its date beats showing none.
    const item = ourItem(subscription, config) ?? subscription.items.data[0] ?? null

    // Invoices are a separate call and a separate failure. Losing them must not cost the page
    // its renewal date, so this degrades to an empty list on its own rather than through the
    // catch below — an empty invoice band is a state the screen already draws.
    let invoices: BillingInvoice[] = []
    try {
      const listed = await stripe.invoices.list({
        customer: typeof subscription.customer === 'string'
          ? subscription.customer
          : subscription.customer.id,
        limit: 5,
      })
      invoices = listed.data.map((invoice) => ({
        id: invoice.id ?? '',
        date: formatDate(new Date(invoice.created * 1000).toISOString(), timezone) ?? '',
        amount: formatMoney(invoice.amount_paid || invoice.amount_due, invoice.currency),
        paid: invoice.status === 'paid',
        url: invoice.hosted_invoice_url ?? null,
      }))
    } catch {
      invoices = []
    }

    const live: LiveSubscriptionFacts = {
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      status: subscription.status,
    }

    return {
      // `plan` is from our row. Stated once more because this is the line that matters: the
      // free/pro decision never consults `live`, and `live` only chooses between three states
      // that are all already Pro.
      state: billingState(row, live),
      plan: row.plan,
      cadence: cadenceOf(item),
      renewsOn: formatDate(periodEnd(item) ?? row.currentPeriodEnd, timezone),
      // Stripe's view of a pending cancellation is fresher than ours between the click and the
      // webhook, which is the entire point of reading it live.
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      subscriptionId: row.providerSubscriptionId,
      cardSummary: cardOf(subscription),
      invoices,
      stale: false,
      mode: config.mode,
    }
  } catch {
    return localView(row, timezone, true)
  }
}
