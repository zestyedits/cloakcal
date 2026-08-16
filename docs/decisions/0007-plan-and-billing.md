# 0007 — Plans, pricing, and how billing will write an entitlement

**Status:** accepted, 2026-08-15
**Supersedes:** nothing. **Related:** rule 4 (no service-role key), `CLOAKCAL_MASTER_ARCHITECTURE.md` §1.2 and §7.

## Context

CloakCal had no billing anything: no plan column, no entitlement, no tier in any vocabulary
the product spoke. It needs a signed-in surface showing what plan you are on and what Pro
will cost, and that surface cannot be written until pricing is decided.

Two facts constrain every decision below.

**Nothing shipped can honestly sit in a Pro column.** The architecture doc's binding rule is
"basic privacy is never paywalled. Paid plans sell power, scale, professional workflows,
integrations, automation, and customization, not the right to keep an appointment private."
Cloaking, visibility rules and View As are effectively the whole shipped product, so the whole
shipped product is free. Everything the spec puts behind a paywall — booking, external sync,
teams, automations — is unbuilt, and booking is gated on the unwritten share-key crypto ADR
plus ADR 0004's unresolved "can the server tell whether this email is one of your contacts".

**Sign-ups are closed and the site is not public.** `cloakcal.com` is attached to no Vercel
project and an independent security review is a hard gate before launch. Live payments now
would be code that cannot be exercised against real money for months.

## Decision

### 1. The tiers

**Free — $0.** Everything CloakCal does today, for one person.

**Pro — $8 a month, or $72 a year.** $72 is $6 a month: 25 percent off, three months free.

Pro is **named and priced but not purchasable**. The page says so in those words, and
`e2e/plan.spec.ts` asserts that no purchase control of any kind exists on it.

Anchored on booking, which is the eventual headline: Calendly Standard is $10/mo and Cal.com
Pro is $15/mo, so $8 sits under both while sitting above Proton Mail Plus, the closest
privacy comparison. The 25 percent annual discount satisfies the spec's "annual pricing
should be visibly better value". No sales-led tier, per the same section.

The line that holds it together: **Free is your calendar. Pro is the work that happens around
it.** Every planned Pro feature is about other people or other systems, which is exactly why
none of them touches the privacy promise.

| Planned for Pro | Why it is not here yet |
|---|---|
| Booking pages and clients | Gated on the share-key crypto ADR, unwritten |
| External calendar sync | Deferred by design, no schema |
| Shared calendars | Deferred by design; ADR 0003 pins single-owner |
| Automations around a booking | Deferred by design |

**Export stays on Free, permanently.** Data portability behind a paywall from a privacy
product is indefensible, and `packages/domain/src/ical.ts` is already written. It is listed
under Free's roadmap, not Pro's.

**No published limits, on either tier.** Nothing in the product counts anything, and there is
nowhere to enforce a count: the browser holds a real PostgREST token and can insert straight
into `calendars`, `contacts` and the rest, so a limit inside an RPC is decoration. A number on
the page that the eleventh calendar sails past is the same failure as the sign-up screen that
claimed "We sent a confirmation link to X" when it had sent nothing. Limits get published the
day they are metered. Until then `apps/web/src/lib/plans.ts` carries none.

### 2. The plan lives in its own table, and the user cannot write it

Migration `0024_subscriptions.sql`: `public.subscriptions`, keyed by `workspace_id`, one
`plan` column, one `for select` policy, and `revoke insert, update, delete ... from
authenticated`.

**Not a column on `workspaces`**, where every other setting lives, because
`workspaces_update` (0002) is `for update to authenticated using (owner_id = auth.uid())` and
a Postgres policy is **row-level**: it cannot name a column, so it authorises every column of
every row it authorises. `workspaces.plan` would be user-writable through PostgREST.

The column-level revoke that looks like the fix is a **silent no-op**. Verified on PGlite
during this work, not reasoned about:

```
before revoke        : plan-update = true   table-update = true
after column revoke  : plan-update = true   table-update = true    <- turned nothing
after table revoke   : plan-update = false  tz-update = true       <- only this bites
  + per-column grant
```

Making it real requires revoking table UPDATE outright and re-granting
`update (timezone, week_start, default_view, keyboard_shortcuts, ...)` column by column — a
hand-maintained allowlist nobody edits when they add a column, whose failure mode is a
preference that silently stops saving, because `set_workspace_prefs` is SECURITY INVOKER and
runs with the caller's privileges. Same family as the 0009 grant trap.

**Absence means Free. There is no bootstrap row and therefore no insert policy.**
`bootstrapWorkspace` runs in the browser under RLS, so provisioning a row would need an insert
policy on the one table that must not have a user-facing write path. Even `with check (plan =
'free')` turns the reviewer's question from "are there any write policies?", answered by
looking, into "is this one tight enough?", re-answered forever. Absence costs one `??`, needs
no backfill, cannot race a future webhook, and fails in the correct direction: a lookup that
finds nothing grants Free, never Pro. `server/plan.ts` also returns Free on a query **error**
rather than throwing — a billing lookup must not 500 the calendar, and the degraded answer is
the generous one.

**One way a user CAN destroy the row, and it is the FK cascade.** `workspaces_delete` (0002)
lets an owner delete their workspace, and a referential action runs internally — checking
neither RLS nor privileges on the referencing table, both of which refuse a direct delete.
Harmless today: it costs the entire workspace and every event in it, and there is no limit to
dodge by doing it. It stops being harmless the moment Stripe is wired, because the local
record of a live paid subscription would vanish while the provider kept charging, with
nothing left to reconcile against. `on delete restrict` is the conventional answer for a
billing table and would break the throwaway-account recipe in CLAUDE.md, so the cascade stays
and the consequence is recorded here instead:

> **Deleting an account must cancel its provider subscription first.** This is an operational
> requirement of the billing work, not a nicety, and there is no database constraint that can
> enforce it.

`subscription.test.ts` performs that delete as the USER rather than through `db.raw`, so the
capability is documented rather than implied.

**The revoke is an allowlist, not three verbs.** `revoke insert, update, delete` was the first
draft and it was not enough: Supabase's default ACL is `authenticated=arwdDxtm`, so naming the
three DML verbs leaves **TRUNCATE** behind — the one verb RLS cannot filter. `revoke all` plus
`grant select` is the spelling, and it cannot be outrun by a privilege that did not exist when
it was written (MAINTAIN is new in PG17). The harness could not have caught this: its shim
granted four of the eight privileges under a comment claiming it mirrored Supabase. It grants
all of them now, and `security-posture.test.ts` sweeps for the same hole on every future table.

**Two independent gates, deliberately.** The missing policies alone would already mean zero
affected rows, but that is denial by omission, which a later permissive policy would quietly
undo. The revokes make the same mistake fail loudly instead.
`packages/db/test/subscription.test.ts` proves each half separately, and both were confirmed
by hand: removing the revoke reds the three write-refusal tests, widening the policy to
`for all` reds the two structural ones.

**No provider columns and no function yet.** All the Stripe columns are nullable, so adding
them is a metadata-only ALTER; five empty ones today would read as "Stripe is wired up".
Nothing can write a plan, so an RPC would wrap an UPDATE that RLS refuses.

### 3. How the webhook will write, without a service-role key

This is the part a future reader most needs, and the reason the table is separate.

Rule 4 forbids a service-role key. `security-posture.test.ts` forbids `SECURITY DEFINER`
functions outright. So a Stripe handler — which has no signed-in user and no session — can
neither bypass RLS nor borrow definer rights. It connects as **its own Postgres role**:

```sql
-- LOGIN, not NOLOGIN, and this is the whole boundary rather than a detail.
-- A `nologin` role has to be reached through `set role` or membership, which means some
-- OTHER role connects. If that connecting role is `postgres` — the obvious path on Supabase
-- — then `reset role` undoes every line below in one statement, and the credential sitting
-- in Vercel is a service-role key with a politeness step in front of it. The role that
-- CONNECTS must itself be the narrow one: a member of nothing, inheriting nothing.
create role billing_writer login password :'BILLING_WRITER_PASSWORD';

grant usage on schema public to billing_writer;
grant select, insert, update on public.subscriptions to billing_writer;

-- Name the verbs. `for all` would also cover DELETE, which is inert only because the grant
-- above withholds it — so a later `grant all` would silently activate a policy nobody
-- re-read. A Postgres policy takes one command, so write the ones you mean.
create policy subscriptions_write on public.subscriptions
  for insert to billing_writer with check (true);
create policy subscriptions_amend on public.subscriptions
  for update to billing_writer using (true) with check (true);
```

On a table holding one fact, that role's blast radius **is** that fact. There is no spelling
of the same grant against `workspaces`: a row-level policy for a writer role would hand it
`lifecycle`, `route_token` and `kind` on every row in the system. Rule 4's purpose — that no
credential in this system can read or rewrite everything — survives intact, and the deviation
is one narrow, auditable, single-table role rather than a master key.

**`using (true)` is unavoidable and it moves the integrity control somewhere else.** A webhook
has no session, so the policy cannot scope by row and the role can write ANY workspace's plan.
That is acceptable for one enum column and unacceptable to leave unstated: it means the
**Stripe-customer-to-workspace mapping is the only thing standing between a bug and a plan
written onto the wrong account**, and the role's narrowness does nothing about that. The
mapping is a prerequisite of this design, not a detail of implementing it — and it is hard
here, because the account email is the KDF salt and therefore not a safe join key to hand a
payment processor. Solve it before writing the handler.

**The role as drawn cannot perform its own lookup, and that is deliberate.** A webhook knows a
Stripe customer, which maps to a user; workspace scoping means it must resolve user to
workspace through `workspaces.owner_id` before it can write. `billing_writer` holds `usage` on
the schema and privileges on `subscriptions` only, so it cannot read `workspaces` at all. That
is stated here because the natural fix under time pressure is to widen the role to
`workspaces` — which is the exact thing this section spends its length arguing against. The
mapping must be resolved OUTSIDE the database (a stored `provider_customer_id` on the
subscriptions row, written on the first checkout while a real session exists) rather than by
giving the writer read access to the account table.

Still to decide when that work starts: webhook idempotency (the spec names delayed and
repeated webhooks as a risk), the exact mapping mechanism above, and whether the connection
string lives in Vercel env or a dedicated pooler.

## Consequences

- **A plan is workspace-scoped, not account-scoped.** Consistent with every other table, and
  the cascade takes it with the account. If a user ever holds two workspaces they hold two
  plans, which is wrong for per-person billing and would need a rollup — cheapest to revisit
  now, before any row exists. ADR 0003 pins single-owner today.
- **The demo has no plan and must never have one in a cookie.** `lib/demo-prefs.ts` draws its
  line at display framing; a plan is the one fact that is not the user's to state.
  `/settings/plan` renders in the demo saying there is no account here, which is both honest
  and what puts the badge and price cards in front of axe at all.
- **The badge shows for Free as well as Pro.** Absent would be ambiguous — free, or unreadable,
  or not loaded — and a badge that appears only when you pay is a status symbol, which inverts
  "paying buys power, not standing".
- **Pro's `includes` list is empty.** Listing shipped features under Pro would be claiming
  free accounts do not have them.
- **TRUNCATE was granted to `anon` AND `authenticated` on all sixteen other public tables**,
  and no policy could take it back, because RLS does not filter TRUNCATE. Found while
  reviewing this migration — `subscriptions` is the first table in the repo that grants SELECT
  and nothing else, and writing its revoke as an allowlist is what exposed the pattern. Latent
  rather than open (PostgREST exposes no TRUNCATE verb and `anon` is NOLOGIN), and fixed in
  `0025_revoke_truncate.sql`, which also drops REFERENCES, TRIGGER and MAINTAIN. Two sweeps
  and one behavioural test in `security-posture.test.ts` are the durable guard, since
  `alter default privileges` cannot reach Supabase's `supabase_admin` defaults.
- **The price is one constant.** `PRO`'s `monthlyCents` / `annualCents` in
  `apps/web/src/lib/plans.ts`. The band considered was $6 to $12; moving inside it before
  anything can be bought costs one edit.
