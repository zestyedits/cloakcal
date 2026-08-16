import type Stripe from 'stripe'
import { stripeClient } from '@/server/billing/stripe'
import {
  billingFailure,
  billingOk,
  billingResponse,
  isFailure,
  prepareBillingRequest,
  readJson,
} from '@/server/billing/request'

/**
 * A Billing Portal DEEP LINK, for the two things that cannot happen on our domain.
 *
 * The portal is not this product's management surface — cancel, resume and the cadence switch
 * all live on /settings/plan and go through `/api/billing/subscription`. This route exists for
 * exactly two actions, and both are genuine limits rather than choices we declined to make:
 *
 *   payment_method — TAKING A CARD NUMBER ON OUR OWN DOMAIN NEEDS STRIPE.JS AND ELEMENTS,
 *     which means a third-party script in a bundle whose entire threat model is that XSS
 *     equals total compromise, plus prising open `frame-src`, `connect-src` and
 *     `Permissions-Policy: payment=()` to do it. A deep link keeps csp.ts untouched and keeps
 *     the card number out of a page that decrypts calendar content.
 *
 *   update_confirm — 3DS. When a proration charge needs the cardholder's bank to confirm it,
 *     there is no headless path. Stripe provides this flow for precisely that case.
 *
 * `flow_data` is what makes a deep link a deep link: the customer lands on one purpose-built
 * page with the portal's own navigation hidden, and comes straight back here afterwards.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Flow = 'payment_method' | 'update_confirm'

const isFlow = (value: unknown): value is Flow =>
  value === 'payment_method' || value === 'update_confirm'

export async function POST(request: Request): Promise<Response> {
  const prepared = await prepareBillingRequest(request)
  if (isFailure(prepared)) return billingResponse(prepared)

  const { config, subscription, origin } = prepared

  const customer = subscription.providerCustomerId
  if (customer === null) return billingFailure('no_customer', 409)

  const body = await readJson(request)
  const flow = body['flow']
  if (!isFlow(flow)) return billingFailure('bad_request', 400)

  const current = subscription.providerSubscriptionId
  if (flow === 'update_confirm' && current === null) {
    return billingFailure('no_subscription', 409)
  }

  const stripe = stripeClient(config)

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer,
      /*
       * PASSED EXPLICITLY, never left to "the account default". A dashboard edit to the
       * default configuration would silently change what this app does, in production, with no
       * commit anywhere. Same instinct as pinning the webhook endpoint's API version.
       *
       * It is also load-bearing for the flows below: a deep link 400s when the feature it
       * needs is disabled, and `payment_method_update` is enabled by `pnpm billing:setup` in
       * the configuration this id names.
       */
      configuration: config.portalConfigurationId,
      return_url: `${origin}/settings/plan`,
      flow_data: flowFor(flow, current),
    })

    return billingOk({ url: session.url })
  } catch (error) {
    console.error(
      '[billing] portal session failed:',
      error instanceof Error ? error.message : String(error),
    )
    return billingFailure('provider_unavailable', 502)
  }
}

function flowFor(
  flow: Flow,
  subscriptionId: string | null,
): Stripe.BillingPortal.SessionCreateParams.FlowData {
  if (flow === 'payment_method') return { type: 'payment_method_update' }
  // `subscription_update_confirm` needs the item it is confirming. Unreachable with a null id,
  // which the caller already refused, and the assertion keeps that true if the caller changes.
  if (subscriptionId === null) throw new Error('update_confirm needs a subscription')
  return {
    type: 'subscription_update_confirm',
    subscription_update_confirm: { subscription: subscriptionId, items: [] },
  }
}
