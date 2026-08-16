import type Stripe from 'stripe'
import { stripeClient } from '@/server/billing/stripe'
import { customerIdOf, ourItem } from '@/server/billing/subscription-item'
import { formatMoney } from '@/lib/plans'
import {
  billingFailure,
  billingOk,
  billingResponse,
  isFailure,
  prepareBillingRequest,
  readJson,
} from '@/server/billing/request'

/**
 * Cancel, resume and switch cadence — ON OUR OWN DOMAIN, with no redirect.
 *
 * This route is why the Billing Portal is not the primary surface. The portal is a redirect to
 * a Stripe-hosted page that Stripe forbids iframing, so routing a cancel through it would fail
 * the product requirement outright. These three are ordinary Subscriptions API calls, and the
 * page that renders them reads its display facts back from Stripe, so a `router.refresh()`
 * after any of them shows the truth immediately — which is the whole reason our own row not
 * being writable from here does not matter. ADR 0009 §1 and §2.
 *
 * CANCEL IS ALWAYS `cancel_at_period_end`, NEVER IMMEDIATE. A cancelled subscription is
 * TERMINAL at Stripe: it cannot be reactivated, only replaced by a new one. Only a PENDING
 * cancellation can be undone, which is what makes the resume below possible at all. An
 * immediate cancel would also throw away time somebody has already paid for.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Intent = 'cancel' | 'resume' | 'switch'

const isIntent = (value: unknown): value is Intent =>
  value === 'cancel' || value === 'resume' || value === 'switch'

export async function POST(request: Request): Promise<Response> {
  const prepared = await prepareBillingRequest(request)
  if (isFailure(prepared)) return billingResponse(prepared)

  const { config, subscription } = prepared
  const body = await readJson(request)

  const intent = body['intent']
  if (!isIntent(intent)) return billingFailure('bad_request', 400)

  const current = subscription.providerSubscriptionId
  // A `pro` row with no subscription id is an account granted Pro by hand. The screen never
  // draws these controls for it; this is the second gate, for a caller that is not the screen.
  if (current === null) return billingFailure('no_subscription', 409)

  /*
   * THE VERSION GUARD, in the house RPC shape: an expected value in, a distinguishable slug
   * out. The page sends back the subscription id it was RENDERED with, and a mismatch means
   * this tab is looking at a subscription that is no longer the current one — two tabs open,
   * or a cancel-and-resubscribe elsewhere. Acting anyway would apply an instruction to the
   * wrong object with money attached.
   */
  if (body['subscriptionId'] !== current) {
    return billingFailure('stale_subscription', 409)
  }

  const stripe = stripeClient(config)

  try {
    if (intent === 'cancel' || intent === 'resume') {
      await stripe.subscriptions.update(current, {
        cancel_at_period_end: intent === 'cancel',
      })
      return billingOk()
    }

    const cadence = body['cadence']
    if (cadence !== 'monthly' && cadence !== 'annual') {
      return billingFailure('bad_request', 400)
    }
    const target = cadence === 'monthly' ? config.priceMonthly : config.priceAnnual

    const live = await stripe.subscriptions.retrieve(current)
    // NO FALLBACK HERE, unlike the two read paths. Swapping an item we do not recognise is
    // how somebody ends up subscribed to two things at once, so this refuses instead.
    const item = ourItem(live, config)
    if (item === null) {
      // A subscription carrying neither of our prices is not something this route can reason
      // about, and swapping an item we do not recognise is how somebody ends up on two plans.
      return billingFailure('no_subscription', 409)
    }
    if (item.price.id === target) return billingOk()

    /*
     * `items[0].id` IS REQUIRED, and omitting it is the single most common way to break a plan
     * switch: Stripe ADDS a second item instead of replacing the first, and the customer ends
     * up subscribed to monthly AND yearly simultaneously. There is no error.
     *
     * `quantity` is restated because changing a price RESETS it to 1 unless carried over.
     *
     * The SAME array is used for the preview and for the change, deliberately: a preview that
     * models different parameters from the update is a number that is not the number.
     */
    const items = [{ id: item.id, price: target, quantity: item.quantity ?? 1 }]
    const proration = 'create_prorations' as const

    /*
     * THE PREVIEW STEP, AND IT IS NOT OPTIONAL POLISH.
     *
     * Switching cadence CHARGES A CARD IMMEDIATELY, for a prorated amount that is neither $8
     * nor $72 — so a button that posts straight through takes money the user was never shown.
     * The Terms say we show the amount before you confirm, and ADR 0009 §2 says the same, and
     * for one commit this route did neither.
     *
     * Note the inversion this fixes: Cancel, which moves no money today, has a two-step
     * confirmation; Switch, which moves money now, had none.
     *
     * If the preview FAILS, no confirm button is rendered and nothing is charged. Refusing to
     * act blind is the same instinct as split-plan.ts proving a truncation is lossless before
     * it is written.
     */
    if (body['confirm'] !== true) {
      const preview = await stripe.invoices.createPreview({
        customer: customerIdOf(live.customer) ?? '',
        subscription: current,
        subscription_details: { items, proration_behavior: proration },
      })

      const due = preview.amount_due
      return Response.json({
        preview: {
          // What is actually taken today. Negative or zero when switching DOWN, where the
          // unused remainder becomes credit against the next invoice rather than a refund —
          // which the copy has to say, because "you will be charged $0" reads as a refund.
          amount: formatMoney(Math.max(due, 0), preview.currency),
          charges: due > 0,
          credit: due < 0 ? formatMoney(-due, preview.currency) : null,
          cadence,
        },
      })
    }

    await stripe.subscriptions.update(current, { items, proration_behavior: proration })
    return billingOk()
  } catch (error) {
    /*
     * 3DS. An immediate proration charge can need the cardholder's bank to confirm it, and
     * that CANNOT be done headlessly — it is the one thing on this route that has to leave our
     * domain. The client turns this slug into a portal deep link at
     * `subscription_update_confirm`, which is precisely what Stripe provides it for.
     */
    if (isStripeCode(error, 'authentication_required')) {
      return billingFailure('needs_confirmation', 409)
    }
    if (isStripeCode(error, 'card_declined')) {
      return billingFailure('card_declined', 402)
    }
    if (isStripeType(error, 'StripeRateLimitError')) {
      return billingFailure('rate_limited', 429)
    }

    // Never Stripe's own message. A decline reason can carry information the issuer gave us
    // and the cardholder's own bank has not.
    console.error(
      `[billing] ${intent} failed:`,
      error instanceof Error ? error.message : String(error),
    )
    return billingFailure('provider_unavailable', 502)
  }
}

const isStripeCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as Stripe.StripeRawError).code === code

const isStripeType = (error: unknown, type: string): boolean =>
  error instanceof Error && error.name === type
