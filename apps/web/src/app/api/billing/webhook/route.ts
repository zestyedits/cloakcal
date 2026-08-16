import type Stripe from 'stripe'
import { applyBillingEvent } from '@/server/billing/apply'
import { billingConfig } from '@/server/billing/config'
import { stripeClient } from '@/server/billing/stripe'

/**
 * The Stripe webhook. The only endpoint in this application that writes a plan.
 *
 * IT IS IN `PUBLIC_PATHS`, and that is the FOURTH appearance of one shape in this codebase: a
 * route that must run for somebody with no session, guarded by the thing that checks for a
 * session. `/auth/callback`, `/opengraph-image` and `/recover` were the first three. Stripe
 * has no cookies and never will, so without that entry every delivery would be answered with
 * a 307 to `/sign-in` — and nothing here would see it, because dev and every Playwright
 * project take middleware's dev-unlock early return before any redirect happens.
 * `middleware-paths.server.test.ts` pins it.
 *
 * `runtime = 'nodejs'` is not negotiable: the Postgres driver needs it.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Bounded well under Stripe's own patience, and above the 4s Stripe-call budget plus a retry. */
export const maxDuration = 15

export async function POST(request: Request): Promise<Response> {
  const config = billingConfig()

  /*
   * 503, NOT 404, AND THE DIFFERENCE MATTERS OVER DAYS.
   *
   * The two user-facing routes answer 404 when billing is off, because from the caller's side
   * the feature does not exist. Stripe is not a caller with an opinion — it is a retry loop.
   * A 404 counts as a permanent failure toward endpoint disablement, and a disabled endpoint
   * is the most silent failure in this design: the app keeps rendering perfectly, because 0024
   * made absence mean Free, so a subscription row that was never written is indistinguishable
   * from a free account. 503 keeps Stripe retrying long enough for a deploy to fix it.
   */
  if (config === null) return new Response(null, { status: 503 })

  /*
   * THE RAW BODY, BEFORE ANYTHING ELSE, AND NEVER `request.json()`.
   *
   * The signature is computed over the exact bytes Stripe sent. Parsing and re-serialising
   * changes them — key order, whitespace, unicode escapes — and every delivery then fails
   * verification for a reason that looks like a wrong secret. The App Router does not
   * pre-parse a body, so there is no `bodyParser: false` to set; there is only the discipline
   * of reading text. `billing-routes.server.test.ts` asserts this file contains `req.text()`
   * and does not contain `req.json()`.
   */
  const raw = await request.text()
  const signature = request.headers.get('stripe-signature')
  if (signature === null) return new Response(null, { status: 400 })

  const stripe = stripeClient(config)

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(raw, signature, config.webhookSecret)
  } catch {
    // NO DETAIL ABOUT WHY. A verbose signature error is an oracle: "timestamp outside
    // tolerance" and "no matching signature" are different facts, and telling them apart is
    // useful to exactly one kind of caller.
    return new Response(null, { status: 400 })
  }

  /*
   * MODE MUST MATCH THE KEY. `billingConfig()` only accepts `sk_test_`, so any live event
   * reaching this deployment is either a misconfigured endpoint or somebody else's traffic,
   * and applying it would write a real subscription into a test-mode database. Cheap, and it
   * fails in the direction that changes nothing.
   */
  if (event.livemode) {
    console.warn('[billing] refused a live event on a test-mode deployment', event.id)
    return new Response(null, { status: 400 })
  }

  try {
    const outcome = await applyBillingEvent(event, config)

    /*
     * LOGGED WITHOUT NAMING ANYBODY. Rule 2 forbids plaintext crossing back out to a log, and
     * while a workspace id is not event content it is still an account identifier in a place
     * with a different retention policy from the database. The RPC audit rows take the same
     * shape: enough to reconstruct what happened, not enough to say whose calendar it was.
     * The customer id in the unknown-customer branch is the exception, and it is deliberate —
     * it is Stripe's own identifier, it names nothing on our side, and it is the only thing
     * that makes an orphaned subscription findable.
     */
    if (outcome.kind === 'unknown-customer') {
      console.warn(
        `[billing] ${event.type} for unknown customer ${outcome.customerId}. ` +
          'Recorded and acknowledged. If this persists, the subscription was probably created ' +
          'in the dashboard rather than through checkout, and has no workspace to belong to.',
      )
    } else if (outcome.kind === 'ignored') {
      console.info(`[billing] ${event.type} ignored: ${outcome.reason}`)
    }

    return new Response(null, { status: 200 })
  } catch (error) {
    /*
     * 500, so Stripe retries. The transaction rolled back, which means the event id was
     * un-claimed too, so the retry is a clean re-run rather than an event its own idempotency
     * guard has already swallowed.
     */
    console.error(
      `[billing] failed to apply ${event.type}: `,
      error instanceof Error ? error.message : String(error),
    )
    return new Response(null, { status: 500 })
  }
}
