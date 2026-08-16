import 'server-only'
import Stripe from 'stripe'
import { type BillingConfig } from './config'

/**
 * The Stripe client.
 *
 * NO `apiVersion`, DELIBERATELY. Since stripe-node v12 the SDK sends the version it was built
 * against, and that version is what makes its TypeScript types accurate — Stripe's own docs
 * warn that overriding it "might cause inaccurate TypeScript types". So the npm version IS the
 * API version, which is why `stripe` is pinned exactly in package.json rather than carets.
 * The one place a version is written by hand is the webhook ENDPOINT, in `pnpm billing:setup`,
 * because an endpoint's version decides the shape of what Stripe posts to us and defaults to
 * the ACCOUNT default, which can silently differ from this build.
 *
 * `timeout` IS A BUDGET, NOT A NICETY. The webhook holds a Postgres transaction open across a
 * Stripe call (ADR 0009 §5: the row lock has to be taken before the fetch, or two handlers
 * race and the older snapshot wins). The role carries
 * `idle_in_transaction_session_timeout = '10s'`, so this must fire FIRST — 4 seconds plus one
 * retry stays inside it, and the failure is then a clean rollback we chose rather than a
 * transaction Postgres killed. Checkout also waits up to 10 seconds for a registered
 * `checkout.session.completed` endpoint before redirecting the customer, so a slow handler is
 * a customer staring at a spinner.
 *
 * `maxNetworkRetries: 1`, not the default 2, for the same budget. Retries here are cheap
 * insurance against a single dropped connection; a third attempt would push the tail past the
 * transaction timeout, which converts a slow Stripe into a Postgres error.
 */

/**
 * Cached on globalThis rather than at module scope, because `next dev` re-evaluates the module
 * on every HMR pass. A module-level client would build a new agent and a new connection pool on
 * every save. Keyed by the secret so a key change in `.env.local` cannot be served a client
 * still holding the old one — which would fail as "No such price", pointing at the wrong thing.
 */
const CACHE = Symbol.for('cloakcal.stripe')

interface Cached {
  key: string
  client: Stripe
}

const store = globalThis as typeof globalThis & { [CACHE]?: Cached }

export function stripeClient(config: BillingConfig): Stripe {
  const cached = store[CACHE]
  if (cached !== undefined && cached.key === config.secretKey) return cached.client

  const client = new Stripe(config.secretKey, {
    timeout: 4_000,
    maxNetworkRetries: 1,
    // Shows up in Stripe's request logs beside every call, which is the only way to tell our
    // traffic apart from the CLI's when debugging a webhook at two in the morning.
    appInfo: { name: 'CloakCal', url: 'https://cloakcal.com' },
  })

  store[CACHE] = { key: config.secretKey, client }
  return client
}
