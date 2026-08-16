-- 0029 — the billing_writer role settings the webhook's design actually depends on.
--
-- WHY THESE ARE IN A MIGRATION AND THE PASSWORD IS NOT.
--
-- 0028 created `billing_writer` NOLOGIN with no password, because a password in a committed
-- migration is a password in the git history forever. That reasoning covers the credential and
-- nothing else — and everything below is a LIMIT rather than a secret. Leaving them in a
-- hand-run snippet in docs/deploy.md meant four properties that three separate source files
-- cite as safety guarantees existed only in a document, applied by whoever remembered:
--
--   packages/db/src/billing-queries.ts   "the role carries idle_in_transaction_session_timeout"
--   apps/web/src/server/billing/stripe.ts "this must fire FIRST"
--   apps/web/src/server/billing/db.ts     "the role carries connection limit 5"
--
-- A guarantee that lives in a runbook is a guarantee nobody has. Skip that snippet and a
-- Stripe hang pins a pooler slot with nothing to reclaim it, which is the exact failure the
-- design claims to have covered.
--
-- After this, the ONE thing that still has to be done by hand, once, out of band, is:
--
--   alter role billing_writer with login password '<generated>';
--
-- See docs/deploy.md. Until that runs, the role cannot connect at all.

do $$
begin
  -- Idempotent because PGlite replays every migration from scratch, and because 0028 already
  -- guards its `create role` the same way. `alter role` on a missing role is an error, not a
  -- no-op, so a fresh database that somehow skipped 0028 would fail here rather than silently
  -- leaving the limits unset.
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'billing_writer') then
    raise exception 'billing_writer does not exist; 0028 must run before 0029';
  end if;

  -- Every statement in billing-queries.ts is schema-qualified, so this changes nothing today.
  -- It is here so that a future unqualified statement resolves to `public` rather than to
  -- whatever the pooler happened to leave in the search path.
  execute 'alter role billing_writer set search_path = public';

  /*
   * LONGER THAN THE STRIPE BUDGET, DELIBERATELY, AND THIS WAS WRONG THE FIRST TIME.
   *
   * The webhook holds a transaction open across a Stripe call — it has to, because the row
   * lock must be taken before the fetch or two concurrent deliveries race and the older
   * snapshot wins. The Stripe client allows 4s plus one retry, so a worst case is a little
   * over 8s while holding the lock.
   *
   * docs/deploy.md said `statement_timeout = '8s'`, which is BELOW that. A second delivery for
   * the same customer blocks on `select ... for update`, and an 8s statement timeout would
   * kill the WAITER before the holder could possibly finish — turning a normal concurrent
   * delivery into a guaranteed 500 rather than a merely possible one. 20s clears the holder's
   * worst case with room, and Vercel's own maxDuration = 15 is the real outer bound anyway.
   */
  execute 'alter role billing_writer set statement_timeout = ''20s''';

  /*
   * THE ONE THAT STOPS A STRIPE OUTAGE BECOMING A DATABASE OUTAGE. If Stripe hangs inside the
   * open transaction and the client's own timeout somehow does not fire, Postgres kills the
   * session and the pooler slot comes back. Without it, a slow provider holds a connection
   * from a pool of five until something else notices.
   */
  execute 'alter role billing_writer set idle_in_transaction_session_timeout = ''15s''';

  -- Bounds a retry storm. Stripe re-delivers on failure, and a burst of concurrent webhooks
  -- must not be able to exhaust the pooler for the rest of the application.
  execute 'alter role billing_writer connection limit 5';
end
$$;
