/**
 * THE FOUR STATEMENTS THE BILLING WEBHOOK ISSUES, as plain SQL strings.
 *
 * ZERO IMPORTS, DELIBERATELY, and this file must keep it that way. It is reachable from
 * `apps/web` through the `@cloakcal/db/billing-queries` subpath, and `packages/db`'s main
 * entry pulls in PGlite and the crypto package — a single import here would drag a WASM
 * Postgres into the web server's bundle.
 *
 * WHY STRINGS RATHER THAN A TAGGED TEMPLATE. The handler talks to Supabase's pooler through
 * postgres.js; the tests talk to PGlite. Neither can execute the other's tagged template, but
 * both accept `(text, params)` — postgres.js as `sql.unsafe(text, params)`, PGlite as
 * `query(text, params)`. "Unsafe" there names the query TEXT being caller-supplied, not the
 * values, which still travel as bind parameters and are never interpolated.
 *
 * The alternative was two copies, one in the handler and one in the test, and a test that
 * proves a statement nothing runs is worse than no test: it reports green about a shape that
 * has drifted. Same argument `packages/policy`'s shared vectors make for the redaction engine.
 *
 * WHAT THE ROLE MAY DO IS THE OTHER HALF, and it is not stated here. `billing_writer` holds
 * SELECT, INSERT and UPDATE on `subscriptions`, SELECT and INSERT on `billing_events`, and
 * nothing anywhere else — no DELETE on either, because a writer that can delete can also cover
 * its tracks. `packages/db/test/billing-writer.test.ts` proves that by running AS the role.
 */

/**
 * Claim an event id. Zero rows back means somebody already applied it.
 *
 * `on conflict do nothing returning`, NOT "insert and catch the unique violation". A unique
 * violation aborts the whole transaction, so the catch would have to unwind and reopen it,
 * losing the row lock taken below. Under `do nothing`, a concurrent duplicate simply BLOCKS
 * until the other transaction commits and then correctly returns nothing.
 *
 * IT MUST RUN INSIDE THE SAME TRANSACTION AS THE WRITE. If the id committed separately and
 * the write then failed, Stripe's retry would find the id present, conclude the work was done,
 * and the plan would never land — an event swallowed by its own idempotency guard. Sharing the
 * transaction means a failure rolls back both, so a retry is a clean re-run.
 *
 * $1 event id, $2 event type, $3 the PROVIDER's timestamp (seconds since the epoch).
 */
export const CLAIM_EVENT = `
  insert into public.billing_events (event_id, event_type, occurred_at)
  values ($1, $2, to_timestamp($3))
  on conflict (event_id) do nothing
  returning event_id
`

/**
 * Resolve a provider customer to a workspace, and take the row lock.
 *
 * `for update` BEFORE the Stripe fetch, not after, and that ordering is the point. Re-fetching
 * from the API fixes STALE PAYLOADS, which is what Stripe's "events are not ordered" warning
 * is about. It does nothing about two handlers racing: A fetches, B fetches, B writes, A
 * writes, and A's older snapshot wins. Locking first serialises the fetches, so the last
 * committer always read after the previous one committed.
 *
 * The cost is a network call inside an open transaction, which is why the role carries
 * `idle_in_transaction_session_timeout = '10s'` and the Stripe client a 4 second timeout: the
 * client gives up first and we roll back deliberately, and if it somehow does not, Postgres
 * kills the transaction. Either way Stripe retries, which is the correct failure direction.
 *
 * IT LOCKS NOTHING WHEN THE ROW DOES NOT EXIST YET, which is worth stating because the
 * paragraph above reads as if it always applies. The FIRST `checkout.session.completed` for an
 * account is the event that CREATES the row, so it takes no lock, and what actually serialises
 * two concurrent first writes is the primary key conflict inside the upsert — last committer
 * wins, on possibly older snapshots. Low impact, because every branch re-fetches from the API
 * anyway. If the guarantee is ever wanted unconditionally, `pg_advisory_xact_lock` keyed on the
 * workspace id holds whether the row is there or not.
 *
 * `billing_writer` cannot read `workspaces` at all (ADR 0007 spends a page on why widening it
 * is the wrong fix), so this table is the ONLY place the mapping can be looked up.
 *
 * $1 provider customer id.
 */
export const LOCK_BY_CUSTOMER = `
  select workspace_id
  from public.subscriptions
  where provider_customer_id = $1
  for update
`

/** The same lock, when the workspace id came from an authenticated session at checkout. */
export const LOCK_BY_WORKSPACE = `
  select workspace_id
  from public.subscriptions
  where workspace_id = $1
  for update
`

/**
 * Write the plan.
 *
 * KEYED ON `workspace_id`, WHICH CAME FROM A SESSION AND NEVER FROM THE PAYLOAD. The policies
 * on this table are `using (true)` — a webhook has no session, so RLS cannot scope by row —
 * which ADR 0007 names as leaving the customer-to-workspace mapping as the only thing between
 * a bug and a plan written onto somebody else's account. The caller validates $1 as a uuid
 * before it reaches here: a malformed value is a bug, and a well-formed WRONG value is that
 * exact failure.
 *
 * `on conflict do update` rather than a separate insert and update, because a returning
 * customer already has a row from a previous subscription and the two cases are otherwise
 * identical.
 *
 * $1 workspace, $2 plan, $3 customer, $4 subscription, $5 status, $6 period end (ISO or null),
 * $7 cancel at period end.
 */
export const UPSERT_SUBSCRIPTION = `
  insert into public.subscriptions
    (workspace_id, plan, provider_customer_id, provider_subscription_id,
     provider_status, current_period_end, cancel_at_period_end)
  values ($1, $2, $3, $4, $5, $6::timestamptz, $7)
  on conflict (workspace_id) do update set
    plan                     = excluded.plan,
    provider_customer_id     = excluded.provider_customer_id,
    provider_subscription_id = excluded.provider_subscription_id,
    provider_status          = excluded.provider_status,
    current_period_end       = excluded.current_period_end,
    cancel_at_period_end     = excluded.cancel_at_period_end
  returning workspace_id, plan
`

/**
 * A uuid, checked before it reaches SQL.
 *
 * Not defence against injection — the values above are bind parameters. It is defence against
 * a `client_reference_id` that is well-formed nonsense: the insert would succeed against a
 * foreign key that happens to exist, and somebody else's account would acquire a plan.
 *
 * IT ACCEPTS VERSIONS 1 TO 5 ONLY. `workspaces.id` is `gen_random_uuid()`, which is v4, so it
 * fits today. If anything ever moves to UUIDv7 this regex silently rejects every real id and
 * EVERY CHECKOUT becomes `ignored` — a total billing outage that looks like nothing at all,
 * because the events are acknowledged with a 200. Widen the version nibble in the same commit.
 */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
