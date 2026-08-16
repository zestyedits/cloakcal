import type Stripe from 'stripe'
import { stripeClient } from '@/server/billing/stripe'
import {
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
  if (!isIntent(intent)) return Response.json({ error: 'bad_request' }, { status: 400 })

  const current = subscription.providerSubscriptionId
  // A `pro` row with no subscription id is an account granted Pro by hand. The screen never
  // draws these controls for it; this is the second gate, for a caller that is not the screen.
  if (current === null) return Response.json({ error: 'no_subscription' }, { status: 409 })

  /*
   * THE VERSION GUARD, in the house RPC shape: an expected value in, a distinguishable slug
   * out. The page sends back the subscription id it was RENDERED with, and a mismatch means
   * this tab is looking at a subscription that is no longer the current one — two tabs open,
   * or a cancel-and-resubscribe elsewhere. Acting anyway would apply an instruction to the
   * wrong object with money attached.
   */
  if (body['subscriptionId'] !== current) {
    return Response.json({ error: 'stale_subscription' }, { status: 409 })
  }

  const stripe = stripeClient(config)

  try {
    if (intent === 'cancel' || intent === 'resume') {
      await stripe.subscriptions.update(current, {
        cancel_at_period_end: intent === 'cancel',
      })
      return Response.json({ ok: true })
    }

    const cadence = body['cadence']
    if (cadence !== 'monthly' && cadence !== 'annual') {
      return Response.json({ error: 'bad_request' }, { status: 400 })
    }
    const target = cadence === 'monthly' ? config.priceMonthly : config.priceAnnual

    const live = await stripe.subscriptions.retrieve(current)
    const item = live.items.data.find(
      (candidate) =>
        candidate.price.id === config.priceMonthly || candidate.price.id === config.priceAnnual,
    )
    if (item === undefined) {
      // A subscription carrying neither of our prices is not something this route can reason
      // about, and swapping an item we do not recognise is how somebody ends up on two plans.
      return Response.json({ error: 'no_subscription' }, { status: 409 })
    }
    if (item.price.id === target) return Response.json({ ok: true })

    await stripe.subscriptions.update(current, {
      /*
       * `items[0].id` IS REQUIRED, and omitting it is the single most common way to break a
       * plan switch: Stripe ADDS a second item instead of replacing the first, and the
       * customer ends up subscribed to monthly AND yearly simultaneously. There is no error.
       *
       * `quantity` is restated because changing a price RESETS it to 1 unless carried over.
       * It is always 1 here today, and writing it means that stays true by statement rather
       * than by coincidence.
       */
      items: [{ id: item.id, price: target, quantity: item.quantity ?? 1 }],
      proration_behavior: 'create_prorations',
    })
    return Response.json({ ok: true })
  } catch (error) {
    /*
     * 3DS. An immediate proration charge can need the cardholder's bank to confirm it, and
     * that CANNOT be done headlessly — it is the one thing on this route that has to leave our
     * domain. The client turns this slug into a portal deep link at
     * `subscription_update_confirm`, which is precisely what Stripe provides it for.
     */
    if (isStripeCode(error, 'authentication_required')) {
      return Response.json({ error: 'needs_confirmation' }, { status: 409 })
    }
    if (isStripeCode(error, 'card_declined')) {
      return Response.json({ error: 'card_declined' }, { status: 402 })
    }
    if (isStripeType(error, 'StripeRateLimitError')) {
      return Response.json({ error: 'rate_limited' }, { status: 429 })
    }

    // Never Stripe's own message. A decline reason can carry information the issuer gave us
    // and the cardholder's own bank has not.
    console.error(
      `[billing] ${intent} failed:`,
      error instanceof Error ? error.message : String(error),
    )
    return Response.json({ error: 'provider_unavailable' }, { status: 502 })
  }
}

const isStripeCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as Stripe.StripeRawError).code === code

const isStripeType = (error: unknown, type: string): boolean =>
  error instanceof Error && error.name === type
