import 'server-only'
import postgres from 'postgres'

/**
 * THE ONLY WRITE-CAPABLE DATABASE CONNECTION IN THIS APPLICATION, and it may be imported by
 * exactly one file: `app/api/billing/webhook/route.ts`. `billing-boundary.server.test.ts`
 * fails the build if a second importer appears.
 *
 * THAT RULE IS NOT FUSSINESS. Everything else in CloakCal reaches Postgres through PostgREST
 * as the signed-in user, under RLS, which is rule 4: no credential in this system can read or
 * rewrite everything. This module is the one exception ADR 0007 designed instead of a
 * service-role key — a role that holds privileges on `subscriptions` and `billing_events` and
 * on literally nothing else, proved by `packages/db/test/billing-writer.test.ts` running AS
 * the role. Importing it from a page would put a write-capable connection one import away from
 * code that has a user session in scope, and would pull a Postgres driver into that route's
 * server bundle.
 *
 * IT IS ALSO INVISIBLE TO THE EXISTING GUARD. `plan-badge.server.test.ts` greps app source for
 * `from('subscriptions')…insert|update|upsert|delete` — a PostgREST shape. This speaks raw
 * SQL, so that sweep will stay green while a second write path exists that it cannot see. The
 * single-importer assertion lands in the same commit for exactly that reason.
 */

/**
 * `prepare: false` IS MANDATORY ON SUPABASE'S TRANSACTION POOLER, and omitting it is invisible
 * until it is not. A direct connection accepts named prepared statements happily, so a laptop
 * and a preview deploy both work; Supavisor in transaction mode multiplexes sessions across
 * backends, and the resulting "prepared statement already exists" appears intermittently, in
 * production, under concurrency, on the path that has already taken somebody's money.
 *
 * `max: 1` because a serverless invocation handles one webhook. A pool of ten multiplies
 * pooler slots by whatever concurrency Stripe happens to send, and the role carries
 * `connection limit 5` to bound exactly that.
 */
const OPTIONS = {
  prepare: false,
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,

  /*
   * TLS SET HERE, NOT LEFT TO THE CONNECTION STRING, AND THE DEFAULT IS THE REASON.
   *
   * postgres.js resolves every option as `k in options ? options[k] : k in query ? query[k]
   * : default`, and **the default for `ssl` is `false`**. So without this line the only thing
   * turning encryption on is somebody having typed `?sslmode=require` into an environment
   * variable — and `billingConfig()` validates that string's PREFIX character by character
   * while saying nothing at all about its query.
   *
   * Paste the URL into Vercel without the suffix and the `billing_writer` password and every
   * subscription row cross the network in cleartext. No error, no test, and nothing in this
   * repo able to see it. `.env.example` has the suffix, which is exactly the kind of
   * correctness that survives right up until somebody retypes a value.
   *
   * Because OPTIONS wins over the query string, this makes it unskippable rather than merely
   * documented. `verify-full` would be stronger still — `require` encrypts without
   * authenticating the peer — but it needs a root certificate story on Vercel that does not
   * exist yet, and encrypted-but-unverified beats plaintext by a wide margin. Recorded rather
   * than quietly settled for.
   */
  ssl: 'require',
} as const

/**
 * Cached on globalThis, keyed by the URL.
 *
 * `next dev` re-evaluates a module on every HMR pass, so a module-scope client would open a
 * fresh pooler connection on every save until Supavisor refused new ones — and the failure
 * would surface somewhere else entirely, as "too many connections" on a page that has nothing
 * to do with billing. Keyed by the URL so editing `.env.local` cannot be served a client still
 * holding the old credential.
 */
const CACHE = Symbol.for('cloakcal.billing.db')

type Sql = ReturnType<typeof postgres>

const store = globalThis as typeof globalThis & { [CACHE]?: { url: string; sql: Sql } }

export function billingDb(databaseUrl: string): Sql {
  const cached = store[CACHE]
  if (cached !== undefined && cached.url === databaseUrl) return cached.sql

  const sql = postgres(databaseUrl, OPTIONS)
  store[CACHE] = { url: databaseUrl, sql }
  return sql
}
