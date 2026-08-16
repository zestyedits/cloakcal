-- Billing, part one: the columns a payment processor needs, and the narrow role that writes
-- them. No Stripe-specific vocabulary in any identifier — `provider_*`, so a second processor
-- or a migration away from this one is a value change rather than a schema change.
--
-- READ ADR 0007 BEFORE CHANGING ANYTHING HERE. It argues at length for why the plan is a
-- separate select-only table rather than a column on `workspaces`, and why the writer is a
-- dedicated Postgres role rather than the service key rule 4 bans. The short version: a
-- row-level policy cannot name a column, so any writer role pointed at `workspaces` would also
-- hold `lifecycle` and `route_token` on every row in the system. On a table holding one fact,
-- this role's blast radius IS that fact.
--
-- WHAT THE USER STILL CANNOT DO. `authenticated` keeps SELECT and nothing else — the revokes
-- from 0024 stand untouched, and subscription.test.ts proves an owner cannot write their own
-- plan. Everything below grants to `billing_writer` only.

/* -------------------------------------------------------------------------- */
/* The role                                                                   */
/* -------------------------------------------------------------------------- */

-- NOLOGIN and NO PASSWORD here, deliberately. A password in a committed migration is a
-- password in the git history forever, and this file is public to everyone with repo access.
-- The credential is set out of band, once, by hand:
--
--   alter role billing_writer with login password '<generated>';
--
-- and lives in Vercel's env as the webhook's connection string. Until that runs the role
-- cannot connect at all, which is the correct default for a role that exists before the
-- handler that uses it.
--
-- `create role` is not idempotent and this repo's migrations are replayed from scratch by the
-- PGlite harness on every test run, so the DO block is load-bearing rather than defensive.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'billing_writer') then
    create role billing_writer nologin;
  end if;
end
$$;

-- USAGE on the schema and nothing else. The role cannot see `workspaces`, `events` or
-- `cloaked_fields`, and ADR 0007 spends a paragraph on why widening it to `workspaces` — the
-- natural fix when the customer-to-workspace lookup gets awkward — is the exact thing this
-- design exists to prevent. The lookup is resolved from `subscriptions` alone.
grant usage on schema public to billing_writer;

/* -------------------------------------------------------------------------- */
/* Provider columns                                                           */
/* -------------------------------------------------------------------------- */

alter table public.subscriptions
  -- The processor's customer handle. UNIQUE because it is the join key every webhook after
  -- the first one uses to find its workspace: two rows sharing one customer would make that
  -- lookup ambiguous, and the wrong branch writes a plan onto the wrong account.
  add column provider_customer_id text unique
    constraint subscriptions_provider_customer_shape
    check (provider_customer_id is null or length(provider_customer_id) between 1 and 255),

  add column provider_subscription_id text unique
    constraint subscriptions_provider_subscription_shape
    check (provider_subscription_id is null or length(provider_subscription_id) between 1 and 255),

  -- The processor's own lifecycle word, kept RAW and separate from `plan`. They answer
  -- different questions: `status` is what Stripe thinks, `plan` is what this product grants.
  -- Collapsing them would mean re-deriving entitlement from a foreign vocabulary at every
  -- read, and a status this app has never heard of would have nowhere to land.
  add column provider_status text
    constraint subscriptions_provider_status_shape
    check (provider_status is null or length(provider_status) between 1 and 64),

  -- When the paid period runs out. Nullable because a free row has no period.
  add column current_period_end timestamptz,

  -- Cancelled but still inside the paid period: the user keeps Pro until it lapses. Without
  -- this the plan screen cannot tell "cancelled, ends 3 March" from "cancelled, gone", and
  -- those are very different sentences to show someone who has paid.
  add column cancel_at_period_end boolean not null default false;

comment on column public.subscriptions.provider_customer_id is
  'The payment provider''s customer handle. The join key every webhook after the first uses to resolve its workspace, which is why it is unique.';
comment on column public.subscriptions.provider_status is
  'The provider''s own lifecycle word, raw. Deliberately NOT collapsed into plan: status is what the processor thinks, plan is what this product grants.';

/* -------------------------------------------------------------------------- */
/* Webhook idempotency                                                        */
/* -------------------------------------------------------------------------- */

-- ADR 0007 left idempotency "still to decide". This is the decision.
--
-- Webhooks are at-least-once and out-of-order by design: Stripe retries for days, and a
-- network timeout after a successful write looks identical to a failure. Replaying
-- `customer.subscription.deleted` after `...created` would downgrade a paying customer, so
-- "handle it twice" is not merely wasteful here — it is wrong in the direction that takes
-- something the user paid for.
--
-- The event id is the primary key, so a replay is an insert that violates it. The handler
-- inserts FIRST and treats a unique violation as "already done, acknowledge and stop".
create table public.billing_events (
  -- The provider's event id (evt_… for Stripe). Its own uniqueness is the whole mechanism.
  event_id text primary key
    constraint billing_events_id_shape check (length(event_id) between 1 and 255),
  event_type text not null,
  -- The provider's own timestamp, NOT ours. Out-of-order delivery is resolved by comparing
  -- this against the row being written, so it has to be the processor's clock.
  occurred_at timestamptz not null,
  received_at timestamptz not null default now()
);

comment on table public.billing_events is
  'Seen webhook ids, so an at-least-once delivery is applied at most once. Holds no customer data: an id, a type and two timestamps.';

alter table public.billing_events enable row level security;
alter table public.billing_events force row level security;

/* -------------------------------------------------------------------------- */
/* Grants and policies                                                        */
/* -------------------------------------------------------------------------- */

-- Allowlist, not a subtraction — the lesson 0025 paid for. `revoke all` first, then name the
-- verbs, so a privilege nobody has heard of yet (MAINTAIN arrived pre-granted in PG17) cannot
-- survive by not being on a list of things to remove.
revoke all on public.billing_events from public, anon, authenticated;

grant select, insert, update on public.subscriptions to billing_writer;
grant select, insert            on public.billing_events to billing_writer;

-- NO DELETE, on either table, and that is not an oversight. Nothing about a billing record
-- should be erasable by the thing that writes it: a cancelled subscription is an UPDATE to
-- plan = 'free', and an event that turns out to be a duplicate is already recorded. A writer
-- that can delete can also cover its tracks.

-- Named per command rather than `for all`. A policy takes one command, and `for all` would
-- also cover DELETE — inert only because the grant above withholds it, which means a later
-- `grant all` would silently activate a policy nobody re-read.
create policy subscriptions_write on public.subscriptions
  for insert to billing_writer with check (true);
create policy subscriptions_amend on public.subscriptions
  for update to billing_writer using (true) with check (true);
create policy subscriptions_read_own_writes on public.subscriptions
  for select to billing_writer using (true);

create policy billing_events_write on public.billing_events
  for insert to billing_writer with check (true);
create policy billing_events_read on public.billing_events
  for select to billing_writer using (true);

-- `using (true)` is unavoidable and ADR 0007 says so out loud: a webhook has no session, so
-- the policy cannot scope by row. The integrity control therefore lives in the
-- customer-to-workspace mapping rather than in the policy, and the mapping is the only thing
-- standing between a bug and a plan written onto the wrong account. That is why
-- `provider_customer_id` is UNIQUE and why the first write is keyed by a workspace id that
-- came from an authenticated SESSION at checkout, never from the webhook payload.
