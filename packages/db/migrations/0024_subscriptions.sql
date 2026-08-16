-- ADR 0007 — the plan a workspace is on: readable by its owner, writable by nobody.
--
-- WHAT THIS IS. One row per workspace holding one fact, the tier. There is no row today for
-- any account, and that is the design rather than a gap: ABSENCE MEANS FREE. See "no
-- bootstrap row" below.
--
-- WHY IT IS NOT A COLUMN ON `workspaces`, WHICH IS WHERE EVERY OTHER SETTING LIVES.
-- 0018's header states the rule and it is a good one: preferences are columns on
-- `workspaces` and move through `set_workspace_prefs`, because a second home for the same
-- kind of fact is how the two homes come to disagree. A PLAN IS NOT A PREFERENCE. Every
-- preference is a fact the user is entitled to state about themselves; a plan is a fact the
-- billing system states ABOUT the user, and the user must not be able to state it. That
-- asymmetry is the entire feature, and `workspaces` cannot express it.
--
-- It cannot express it because `workspaces_update` (0002) is `for update to authenticated
-- using (owner_id = auth.uid()) with check (owner_id = auth.uid())`, and a Postgres policy
-- is ROW-level: it cannot name a column, so it authorises every column of every row it
-- authorises. Add `workspaces.plan` and a signed-in user PATCHes themselves to Pro through
-- PostgREST without ever going near an RPC.
--
-- AND THE COLUMN-LEVEL REVOKE THAT LOOKS LIKE THE FIX IS A SILENT NO-OP. Verified on PGlite
-- rather than reasoned about: with the table-level UPDATE grant standing — which is exactly
-- what Supabase's `alter default privileges` hands out at creation, mirrored in
-- packages/db/test/harness.ts — `revoke update (plan) on public.workspaces from
-- authenticated` succeeds, warns about nothing, and leaves `has_column_privilege(...,
-- 'plan', 'update')` true. Making it bite means revoking table UPDATE outright and
-- re-granting `update (timezone, week_start, default_view, keyboard_shortcuts, ...)` column
-- by column: a hand-maintained allowlist nobody edits when they add a column, whose failure
-- mode is a preference that silently stops saving, because `set_workspace_prefs` is SECURITY
-- INVOKER and runs with the caller's own privileges. Same family as the 0009 trap — a
-- statement that reads as a lock and turns nothing.
--
-- WHAT THE WEBHOOK WILL NEED, AND WHY A SEPARATE TABLE IS THE CHEAP ANSWER. Rule 4 forbids a
-- service-role key and security-posture.test.ts forbids SECURITY DEFINER, so a future Stripe
-- handler can neither bypass RLS nor borrow definer rights. It will connect as its own
-- Postgres role with its own policy:
--
--     create policy subscriptions_write on public.subscriptions
--       for insert to billing_writer with check (true);
--     create policy subscriptions_amend on public.subscriptions
--       for update to billing_writer using (true) with check (true);
--
-- NAMED VERBS, not `for all`, which would also cover DELETE — inert only while the grant
-- withholds it, so a later `grant all` would silently arm a policy nobody re-read. ADR 0007
-- §3 is the full argument, including why that role must be LOGIN rather than reached by
-- `set role` from `postgres`.
--
-- On a table holding one fact, that role's blast radius IS that fact. There is no spelling
-- of the same grant against `workspaces`: a row-level policy for a writer role would hand it
-- `lifecycle`, `route_token` and `kind` on every row in the system. Not built here — ADR
-- 0007 records it so the next person does not reach for the service key.
--
-- WHAT IS DELIBERATELY ABSENT:
--
--   * NO FUNCTION. Nothing can write a plan, so an RPC would be a SECURITY INVOKER wrapper
--     around an UPDATE that RLS refuses — a function whose only behaviour is to fail, plus
--     one more name for the anon sweep to carry and a fourth place a plan's shape is
--     described. Schema-only, exactly like 0023.
--
--   * NO INSERT, UPDATE OR DELETE POLICY, and no privilege for them either. RLS is FORCED,
--     so the missing policies alone already mean zero affected rows — but that is denial by
--     omission, which a later permissive policy would quietly undo. The revokes below make
--     the same mistake fail with "permission denied" instead of succeeding silently. Two
--     independent gates, and subscription.test.ts proves each half separately rather than
--     trusting that whichever one fires is the one that was meant to.
--
--   * NO BOOTSTRAP ROW, therefore no insert policy. `bootstrapWorkspace` runs IN THE BROWSER
--     under RLS (apps/web/src/lib/cloak-session.ts), so provisioning a row here would need a
--     policy letting `authenticated` insert into the one table that must not have a
--     user-facing write path. Even the careful spelling — `with check (plan = 'free')` —
--     turns the reviewer's question from "are there any write policies?", which is answered
--     by looking, into "is this one tight enough?", which must be re-answered every time
--     anyone touches this file, forever. Absence costs one `??` in apps/web/src/server/
--     plan.ts, needs no backfill for the accounts that already exist, cannot race a future
--     webhook insert, and fails in the correct direction: a lookup that finds nothing grants
--     Free, never Pro.
--
--   * NO PROVIDER COLUMNS. provider_customer_id, provider_subscription_id, status,
--     current_period_end and cancel_at_period_end all arrive with the webhook that writes
--     them, and every one is nullable, so adding them later is a metadata-only ALTER with no
--     table rewrite. There is no cost being deferred — only five empty columns that would
--     read as "Stripe is wired up" to anyone opening the schema today.
--
-- 'pro' IS A LEGAL VALUE ALREADY, even though nothing can store it. Widening a CHECK is
-- drop-and-recreate (0023's header), and the tier enters the product's vocabulary the moment
-- the settings screen names a price. Nothing can write it, which is precisely what makes
-- allowing it free.

create table public.subscriptions (
  -- The primary key as well as the foreign key: one plan per workspace, so two rows
  -- disagreeing about the tier are unrepresentable rather than merely unlikely. Cascades, so
  -- the throwaway-account recipe in CLAUDE.md takes this with it like everything else.
  --
  -- THE CASCADE IS THE ONE WAY A USER CAN DESTROY THIS ROW, and that is a real hole in
  -- "the user cannot write their plan" rather than a quibble: `workspaces_delete` (0002)
  -- lets an owner delete their workspace, and a referential action runs internally, checking
  -- neither RLS nor privileges on the referencing table. Harmless today, because it takes
  -- the entire workspace and every event with it and there is no limit to dodge by doing it.
  -- It stops being harmless once Stripe is wired: the local record of a live paid
  -- subscription would vanish while the provider kept charging, with nothing left to
  -- reconcile against. `on delete restrict` is the conventional answer for a billing table
  -- and would break the throwaway-account recipe, so the cascade stays and ADR 0007 records
  -- the consequence instead: DELETING AN ACCOUNT MUST CANCEL ITS PROVIDER SUBSCRIPTION
  -- FIRST. subscription.test.ts exercises this as the USER, not as raw, so the capability
  -- is documented rather than implied.
  workspace_id uuid primary key
    references public.workspaces (id) on delete cascade,

  plan text not null default 'free'
    constraint subscriptions_plan_known check (plan in ('free', 'pro')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.subscriptions is
  'Which tier a workspace is on. The account holder may SELECT and nothing else: there is '
  'no insert, update or delete policy and only select is granted. The one exception is the '
  'FK cascade below, which takes this row when the workspace goes -- a referential action '
  'checks neither RLS nor privileges. NO ROW MEANS FREE. '
  'See docs/decisions/0007-plan-and-billing.md.';

comment on column public.subscriptions.workspace_id is
  'The workspace this plan applies to, and the primary key, so one workspace cannot hold '
  'two disagreeing plans.';
comment on column public.subscriptions.plan is
  'The tier: free or pro. The catalog that names and prices these lives in '
  'apps/web/src/lib/plans.ts and this column stores the id only. The ''free'' default is '
  'belt-and-braces for a partial write; ABSENCE, not this default, is what makes an '
  'account free.';
comment on column public.subscriptions.created_at is
  'When a plan was first recorded. No free account has one, because no free account has a '
  'row.';
comment on column public.subscriptions.updated_at is
  'Last change, maintained by the touch trigger below.';

-- Same posture as every other table (0002): enabled AND forced, so a mistakenly-privileged
-- connection cannot walk around the boundary.
alter table public.subscriptions enable row level security;
alter table public.subscriptions force row level security;

-- THE ONLY POLICY, and `for select` rather than `for all` is the guarantee. The predicate is
-- byte-identical to every other workspace-scoped table (0016), so a reviewer checks nothing
-- new here.
create policy subscriptions_select on public.subscriptions
  for select to authenticated
  using (private.is_workspace_member(workspace_id));

-- The second gate, written as an ALLOWLIST rather than as three verbs to subtract.
--
-- `revoke insert, update, delete` was the obvious spelling and it is not enough. Supabase's
-- default ACL for a new public table is `authenticated=arwdDxtm` — verified against
-- pg_default_acl on the live project, not assumed — which is INSERT, SELECT, UPDATE, DELETE,
-- **TRUNCATE**, REFERENCES, TRIGGER and MAINTAIN. Naming the three DML verbs leaves TRUNCATE
-- behind, and TRUNCATE is the one verb row level security cannot filter: a table with RLS
-- forced and a `using (false)` policy is still emptied by it. Confirmed in PGlite.
--
-- Nothing can reach it today (PostgREST exposes no TRUNCATE), so this is defense in depth —
-- but the whole reason this second gate exists is defense in depth, so a hole on that axis
-- is a hole in the only thing it does. And a subtractive list cannot be outrun by a verb
-- that did not exist when it was written: MAINTAIN is exactly such a verb, new in PG17.
--
-- Same shape as the 0009 trap this file's header already cites. Say what `authenticated` MAY
-- do, and let everything else be absent by construction.
revoke all on public.subscriptions from authenticated;
grant select on public.subscriptions to authenticated;

-- And anon reaches nothing at all. It has no policy either, so this is belt-and-braces —
-- but the harness does not mirror Supabase's anon TABLE grants the way it mirrors the
-- function ones, which makes the harness the WEAKER environment for this particular
-- assertion and means it cannot be trusted to catch the omission. Write it anyway.
revoke all on public.subscriptions from anon, public;

-- For the writer that does not exist yet. One line now beats a future migration having to
-- remember, and beats updated_at going stale on the first row anyone ever writes.
create trigger subscriptions_touch
  before update on public.subscriptions
  for each row execute function public.touch_updated_at();
