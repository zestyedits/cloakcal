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
 * Start a Checkout Session. Returns `{ url }` as JSON; it never redirects.
 *
 * WHY JSON AND NOT A 303. `csp.ts` sets `form-action 'self'`, and whether `form-action` applies
 * to redirect TARGETS is undefined in the CSP spec — Chrome and Safari enforce it, Firefox does
 * not. So a `<form method="post">` that 303s to checkout.stripe.com is blocked in two browsers
 * out of three, AND ONLY IN PRODUCTION, because the development policy is deliberately looser
 * and every Playwright project takes the dev-unlock early return. That is the
 * /opengraph-image profile exactly: the one environment nothing runs in is the only one that
 * behaves differently. The client assigns `window.location.href` instead, which is a
 * script-initiated top-level navigation and is governed by no CSP directive at all.
 *
 * `csp.ts` therefore does not change, and `security-headers.server.test.ts` pins that: the
 * production policy names no Stripe origin, `form-action` stays 'self', `frame-src` stays
 * 'none'. Those three lines exist so a future CSP-broken checkout is not "fixed" by widening
 * the policy, which would be treating the symptom of using the wrong navigation API.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const prepared = await prepareBillingRequest(request)
  if (isFailure(prepared)) return billingResponse(prepared)

  const { config, workspaceId, subscription, origin } = prepared

  // Nothing stops somebody POSTing here with a subscription already live. Stripe would happily
  // create a second one and charge for both.
  if (subscription.providerSubscriptionId !== null) {
    return billingFailure('already_subscribed', 409)
  }

  const body = await readJson(request)
  const cadence = body['cadence']
  if (cadence !== 'monthly' && cadence !== 'annual') {
    return billingFailure('bad_request', 400)
  }

  const stripe = stripeClient(config)

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [
        { price: cadence === 'monthly' ? config.priceMonthly : config.priceAnnual, quantity: 1 },
      ],

      /*
       * THE MAPPING, AND THE ONLY TIME A WORKSPACE ID IS EVER SENT TO STRIPE.
       *
       * It comes from `loadWorkspacePrefs()` under the signed-in user's own session, never
       * from the request body. The webhook validates it as a uuid on the way back and keys the
       * first insert on it; every later event resolves through `provider_customer_id` on our
       * own row. ADR 0007 names this as the only thing standing between a bug and a plan
       * written onto the wrong account, because the policies on that table are `using (true)`.
       */
      client_reference_id: workspaceId,
      // Rides along on every later subscription object. FOR RECONCILIATION ONLY, deliberately
      // not used as a mapping source — it is the only way to find a subscription whose local
      // row was destroyed by an account deletion, which ADR 0007 flags and no constraint can
      // prevent.
      subscription_data: { metadata: { workspace_id: workspaceId } },

      /*
       * THE ACCOUNT EMAIL IS NEVER SENT. `deriveMasterSecret` salts with the normalised email,
       * so it is key material as much as an identifier, and ADR 0007 names it outright as not
       * a safe join key to hand a payment processor. Stripe collects a billing email on its
       * own page, which has a side effect worth having here: your billing address need not be
       * the address you sign in with.
       *
       * `customer` is passed when we already have one, so a second purchase after a lapse does
       * not create a duplicate Stripe customer — `provider_customer_id` is UNIQUE in 0028 and a
       * duplicate would make the row unwritable.
       */
      ...(subscription.providerCustomerId !== null
        ? { customer: subscription.providerCustomerId }
        : {}),

      /*
       * ORIGIN FROM THE REQUEST, NOT FROM ENV. `NEXT_PUBLIC_SITE_ORIGIN` falls back to the
       * production URL, so a preview deployment would send a preview user to production after
       * paying — a bug that exists only on preview, which is the environment nobody checks.
       *
       * NO `{CHECKOUT_SESSION_ID}` in the success URL. A session id is a token, and `csp.ts`
       * already states this codebase's rule about tokens in URLs (it is why Referrer-Policy is
       * strict-origin-when-cross-origin). Nothing on the success page needs it: the page
       * re-reads the plan from the database.
       */
      success_url: `${origin}/settings/plan?checkout=done`,
      cancel_url: `${origin}/settings/plan?checkout=cancelled`,
    })

    if (session.url === null) {
      return billingFailure('provider_unavailable', 502)
    }
    return billingOk({ url: session.url })
  } catch (error) {
    // Never Stripe's message. Same rule as GoTrue's PKCE prose and the RPC hints: a
    // processor's error string is written for whoever built the app.
    console.error(
      '[billing] checkout failed:',
      error instanceof Error ? error.message : String(error),
    )
    return billingFailure('provider_unavailable', 502)
  }
}
