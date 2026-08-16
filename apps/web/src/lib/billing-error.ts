/**
 * What a billing route can go wrong with, and what we say about it.
 *
 * A CLOSED UNION MAPPED TO SENTENCES, exactly as `lib/rpc-error.ts` does for the RPCs and as
 * `/auth/callback` does for GoTrue. The rule behind all three:
 *
 * > NEVER FORWARD A PROVIDER'S OWN ERROR TEXT TO A USER.
 *
 * Supabase's PKCE failure reads "PKCE code verifier not found in storage… For SSR frameworks
 * (Next.js, SvelteKit, etc.), use @supabase/ssr on both the server and client" — advice for
 * whoever built the app, shown to someone who clicked a link in their email. Stripe's messages
 * are the same shape, and worse here: a decline reason can carry information the issuer gave
 * us and the cardholder's bank has not.
 *
 * IT LIVES IN lib/ BECAUSE BOTH SIDES READ IT. The route handlers pick a slug, the client
 * component renders the sentence. Two copies of this mapping would be two answers to the same
 * failure, and the one nobody updated would be the one a user reads.
 *
 * EVERY SENTENCE SAYS WHETHER MONEY MOVED. That is the one fact a person actually wants at
 * the moment a billing action fails, and it is the fact a generic "something went wrong"
 * withholds.
 */

export type BillingErrorSlug =
  | 'not_signed_in'
  | 'billing_off'
  | 'no_workspace'
  | 'no_subscription'
  | 'no_customer'
  | 'already_subscribed'
  | 'stale_subscription'
  | 'bad_request'
  | 'card_declined'
  | 'needs_confirmation'
  | 'provider_unavailable'
  | 'rate_limited'

const MESSAGES: Record<BillingErrorSlug, string> = {
  not_signed_in: 'Your session ended. Sign in and try again. Nothing was charged.',
  billing_off: 'Billing is not switched on for this account. Nothing was charged.',
  no_workspace: 'We could not find your workspace. Reload the page and try again.',
  no_subscription: 'There is no subscription on this account to change.',
  /*
   * THIS SLUG WAS EMITTED BY A ROUTE AND MISSING FROM HERE, so it fell through to the
   * `provider_unavailable` sentence — "We could not reach Stripe. Nothing was charged. Try
   * again in a minute." Every clause of that is false, and the last one tells somebody to
   * retry an action that will fail identically forever.
   *
   * The union was never enforced: fifteen of seventeen error responses hand-rolled
   * `Response.json({ error: '…' })` instead of going through the one typed helper, so
   * "a closed union mapped to sentences" was a claim nothing checked. `billingFailure()` in
   * server/billing/request.ts is now the only way a route can name one. Same family as
   * `--ease-out`: a name that did not exist, silently voiding the thing that read it.
   */
  no_customer: 'There is no payment account on file to manage.',
  already_subscribed: 'This account is already on Pro. Reload the page to see it.',
  stale_subscription: 'This page is out of date. Reload it and try again.',
  bad_request: 'That request did not make sense to us. Reload the page and try again.',
  card_declined: 'Your card was declined. Try another card, or check with your bank.',
  needs_confirmation: 'Your bank wants to confirm this. We are sending you to Stripe to do that.',
  provider_unavailable:
    'We could not reach Stripe. Nothing was charged. Try again in a minute.',
  rate_limited: 'Too many attempts. Wait a minute and try again.',
}

export const isBillingErrorSlug = (value: unknown): value is BillingErrorSlug =>
  typeof value === 'string' && Object.hasOwn(MESSAGES, value)

/**
 * The sentence for a slug, or the one for a failure we did not name.
 *
 * The fallback is `provider_unavailable` rather than a generic apology, because it is the
 * only honest thing to say about an outcome we do not understand: we do not know what
 * happened, and we do know that a request that did not visibly succeed should not be assumed
 * to have taken money. Telling somebody to try again in a minute is safe advice in every
 * case this can reach.
 */
export function billingErrorMessage(slug: unknown): string {
  return isBillingErrorSlug(slug) ? MESSAGES[slug] : MESSAGES.provider_unavailable
}
