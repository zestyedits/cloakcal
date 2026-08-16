# 0009 — Stripe: where each billing decision is made, and which one is the entitlement

**Status:** accepted, 2026-08-16
**Supersedes:** nothing. **Related:** ADR 0007 (which this one implements), rule 4 (no
service-role key), migrations `0024_subscriptions.sql` and `0028_billing_writer.sql`.

## Context

ADR 0007 decided the tiers, built the table, and designed a `billing_writer` role that can touch
`subscriptions` and `billing_events` and nothing else. It deliberately stopped short of the
processor, and left three questions open: webhook idempotency, the exact customer-to-workspace
mapping, and where the connection string lives.

Migration 0028 has since closed the first — `billing_events` keys on the provider's event id, so a
replay is a constraint violation the handler reads as "already done". This ADR closes the other two
and decides the shape of everything above the database.

One requirement drives most of what follows, and it is a product requirement rather than a technical
one:

> Users can edit, manage, or cancel their subscription from their settings page without having to go
> into Stripe.

## Decision

### 1. Entitlement is our column. Presentation is Stripe's.

The single most important line in this document, and the one a future reader is most likely to be
tempted to break:

> **`subscriptions.plan` decides what an account may do. Nothing else, ever. The Stripe API is
> read at render time for facts we display — the renewal date, the cadence, the card, the invoices
> — and those facts grant nothing.**

The tempting shortcut, on the day a webhook is late, is to grant Pro from a Stripe response. That
turns the paywall into an outbound HTTP call: it fails open when Stripe is slow, it makes the
entitlement unauditable from the database, and it puts a third party's uptime in the authorisation
path. `packages/policy` is the only place field visibility is decided for exactly this family of
reason, and this is the billing version of the same rule.

The split also solves a real problem rather than merely being principled. Only `billing_writer` may
write `subscriptions`, and it only runs in the webhook — so an in-app cancel cannot update our own
row. Reading display facts live from Stripe means a `router.refresh()` after a cancel shows the
truth immediately, with no optimistic state to reconcile and no flicker back to the old value when
the row catches up a second later. When Stripe is unreachable we fall back to our own columns and
say the details may be out of date, rather than presenting stale columns as live.

### 2. Management happens on our domain. One action cannot, and it is the card.

Stripe's Billing Portal is a redirect to a Stripe-hosted page. It cannot be iframed — Stripe's own
documentation says so under Limitations, and `frame-ancestors 'none'` would be the wrong answer even
if it could. So the portal cannot satisfy the requirement above, and the three actions that matter
are Subscriptions API calls from our own route handler instead:

| Action | Where it happens | How |
|---|---|---|
| Cancel | our page | `subscriptions.update(id, { cancel_at_period_end: true })` |
| Resume a pending cancellation | our page | `subscriptions.update(id, { cancel_at_period_end: false })` |
| Switch monthly ↔ yearly | our page | `subscriptions.update(id, { items: [{ id, price }] })` |
| **Update the card** | **Stripe** | portal deep link, `flow_data.type = 'payment_method_update'` |
| 3DS confirmation on a switch | Stripe | portal deep link, `subscription_update_confirm` |

The card is not a preference we are declining to build. Taking a card number on our own domain
requires Stripe.js and Elements, which puts a third-party script into a bundle whose whole threat
model is that XSS equals total compromise, and it drags `frame-src`, `connect-src` and
`Permissions-Policy: payment=()` open to do it. A deep link keeps `csp.ts` untouched and keeps the
card number out of a page that decrypts calendar content. That trade is worth naming, because "we
could not be bothered" and "we decided not to" look identical from outside.

**Cancel is `cancel_at_period_end`, never immediate.** A cancelled subscription is terminal at
Stripe and cannot be reactivated; only a pending cancellation can be undone. Shipping a cancel
button without a resume button is a trap door, so the two land together.

**A switch that charges money states the amount first.** Press, fetch Stripe's invoice preview,
render the real number, then confirm. If the preview call fails the confirm button does not render.
Refusing to act blind is the same instinct as `split-plan.ts` proving a truncation is lossless
before it is written.

### 3. Nothing leaves our domain by form POST

`csp.ts` sets `form-action 'self'`. Whether `form-action` applies to redirect *targets* is undefined
in the CSP spec; Chrome and Safari enforce it, Firefox does not. So a `<form method="post">` that
303s to `checkout.stripe.com` is blocked in two of three browsers — **and only in production**,
because the development policy is deliberately looser and every Playwright project takes the
dev-unlock early return. That is the `/opengraph-image` failure profile exactly: the one environment
nothing runs in is the only one that behaves differently.

So the client `fetch`es our route, reads `{ url }` from JSON, validates the origin, and assigns
`window.location.href`. A script-initiated top-level navigation is governed by no CSP directive
(`navigate-to` shipped in no browser), and the browser never speaks to Stripe with `fetch` because
there is no Stripe.js in this design.

**Therefore `csp.ts` does not change, and three assertions in
`security-headers.server.test.ts` record it**: the production policy names no Stripe origin,
`form-action` stays `'self'`, and `frame-src` stays `'none'`. Those lines exist so that a future
CSP-broken checkout is not "fixed" by widening the policy, which would be repairing the symptom of
using the wrong navigation API.

### 4. The mapping: `client_reference_id`, once, from a session

ADR 0007 left this open and named it as the only thing standing between a bug and a plan written
onto the wrong account, since `using (true)` cannot scope by row.

The workspace id reaches Stripe exactly once, from an authenticated session, as
`client_reference_id` on the Checkout Session. The first webhook — `checkout.session.completed`, the
only event that carries it — creates the row keyed by it. Every later event resolves customer to
workspace from `provider_customer_id` on `subscriptions`, which is the only table the role can read.

Two consequences worth stating rather than discovering:

- **`client_reference_id` is uuid-validated before it reaches SQL.** A malformed value is a bug; a
  well-formed *wrong* value writes a plan onto someone else's account, which is precisely the risk
  this section exists to bound.
- **`subscription_data.metadata.workspace_id` is set as well, and is deliberately not used for
  mapping.** It costs nothing, it is the only way to detect an orphaned subscription after the fact,
  and using it as a second mapping source would widen the surface ADR 0007 spends a page narrowing.
  It is for reconciliation, not authorisation.

**The account email is never sent to Stripe.** `deriveMasterSecret` salts with the normalised email,
so it is key material as much as it is an identifier, and ADR 0007 names it as not a safe join key
to hand a processor. Stripe collects a billing email on its own page. The side effect is a feature
here: your billing address need not be the address you sign in with.

### 5. Idempotency, ordering, and the transaction that holds them

The handler is one transaction, and the order inside it is the design.

1. `insert into billing_events … on conflict (event_id) do nothing returning event_id`. Zero rows
   means already applied: commit, return 200, do nothing.
2. Resolve the workspace and take `select … for update` on the `subscriptions` row.
3. Re-fetch the subscription from the Stripe API. Never trust the payload.
4. Upsert.

**The event id is claimed inside the same transaction as the write.** If it committed separately and
the write then failed, Stripe's retry would find the id present, conclude the work was done, and the
plan would never land — an event swallowed by its own idempotency guard. Sharing the transaction
means a failure rolls back both, so a retry is a clean re-run.

**The lock is taken before the Stripe fetch, not after.** Re-fetching from the API solves *stale
payloads*, which is what Stripe's "events are not ordered" warning is about. It does nothing about
two handlers racing: A fetches, B fetches, B writes, A writes, and A's older snapshot wins.
Locking first serialises the fetches, so the last committer always read after the previous one
committed. The cost is a Stripe round trip inside an open transaction, which is why the role carries
`idle_in_transaction_session_timeout = '10s'` and the Stripe client a 4s timeout: if Stripe hangs,
the client gives up first and the transaction rolls back cleanly, and if it does not, Postgres kills
it. Either way Stripe retries, which is the correct failure direction.

The rejected alternative was a `provider_event_at` watermark column and `where provider_event_at <
$new`. It needs a migration, and it still leaves the *read* stale — it only stops the write.

**An event for an unknown customer is recorded, committed, 200, and logged.** Because every handler
re-fetches from the API, `checkout.session.completed` will create the row from live state whenever
it arrives, so nothing is lost by dropping an out-of-order sibling. A 5xx would make Stripe retry an
event that cannot succeed until its sibling lands, burning retries toward endpoint disablement. The
only case genuinely dropped is a subscription created by hand in the dashboard for a customer we
have never seen, which is an operator error the log line names.

### 6. Test mode is enforced by the code, not promised by a document

`billingConfig()` returns null unless all six server-only variables are present and well-formed,
**and rejects any `STRIPE_SECRET_KEY` not matching `/^sk_test_/`**. Pasting a live key into Vercel
therefore disables billing rather than enabling real charges. The decision that nothing takes real
money before the independent security review is a property of the build, not a note somebody has to
remember.

It also rejects the literal string `[SENSITIVE]`, which is what `vercel env pull` returns for a
variable typed Sensitive while still exiting 0. That trap has already cost this project once with
the Supabase values, where a placeholder sailed past a loud-failure guard and surfaced later as an
inexplicable network error.

`billingEnabled()` is `CLOAKCAL_BILLING === '1'` **and** `billingConfig() !== null`. A flag set
without keys renders nothing, rather than rendering a purchase button whose route 500s.

**The flag is server-only, unlike `NEXT_PUBLIC_CLOAKCAL_SIGNUPS_OPEN`, and the difference is where
the wall is.** Sign-ups had to be public because the browser talks to Supabase directly, so that
flag is the door and Supabase Auth is the wall. Every billing action goes through our own route
handler, so here the server *is* the wall — and a server-only variable can be flipped without a
redeploy, because nothing inlines it at build time.

**A test-mode `plan = 'pro'` row is indistinguishable from a live one and can outlive test mode.**
`subscriptions` has no `livemode` notion and will not grow one for a single-account product. The
webhook checks `event.livemode` against the key mode so a live event can never be applied by a
test-keyed deployment, but nothing stops a row written in test mode from persisting into live mode.
Clear the table before the first live key, and treat that as a launch step.

### 7. Entitlements are a real map with four unbuilt keys

`lib/entitlements.ts` holds `ENTITLEMENTS: Record<Feature, PlanId>` over `booking`, `external-sync`,
`shared-calendars` and `automations` — the exact four in `planById('pro').planned`, none of which
exist. So the module gates nothing today and takes nothing away from anybody.

An empty map was considered and rejected. It makes `Feature = never`, which makes `hasEntitlement`
uncallable, untestable, and provable only by asserting its own emptiness — a test that fails the day
the module starts doing its job. Populated, the module is exercisable now, shipping booking is one
`requireEntitlement` call in its route handler, and a missing entry is a compile error because
`Record<Feature, PlanId>` is total.

Two invariants are asserted mechanically rather than remembered:

- **Every key of `ENTITLEMENTS` appears in Pro's `planned` list.** You cannot gate a feature the
  pricing page does not disclose.
- **No shipped feature is gated.** A test intersects the feature keys with a list of what ships
  today and requires the intersection to be empty. That is how ADR 0007's "basic privacy is never
  paywalled" stops depending on whoever is reading.

**A degraded plan read denies in `requireEntitlement` and grants Free in `loadPlan`, and that
asymmetry is intentional.** Degrading to Free is generous when you are rendering a badge, correct
when you are granting a capability, and wrong when you are offering a purchase — three call sites,
three right answers, one degraded input. The plan page therefore draws no purchase control at all
when the read is degraded: a paying customer shown an upgrade button, who clicks it, is charged
twice.

## Consequences

- **A signed-out POST to an `/api` route used to redirect, and a redirect is the wrong answer for a
  JSON endpoint.** `fetch` follows a 307 preserving the method, so the browser re-POSTs to
  `/sign-in`, receives HTML, and `res.json()` throws a parse error — the user sees "something went
  wrong" for what is actually "you are signed out", and it looks like a Stripe problem. The
  middleware's guard decision is now the pure function `guardFor(pathname, signedIn)`, testable
  without a server the way `buildCsp` is, returning 401 with a slug for `/api/*`. Every other path
  keeps today's behaviour exactly.
- **`/api/billing/webhook` is in `PUBLIC_PATHS`, and this is the fourth appearance of the same
  shape**: a route that must run for someone with no session, guarded by the thing that checks for a
  session. `/auth/callback`, `/opengraph-image` and `/recover` were the first three. It is
  additionally early-returned above the Supabase client, so a Supabase outage cannot become a
  billing outage for a request that can never carry a session.
- **`plan-badge.server.test.ts`'s write-grep is now blind.** It matches PostgREST calls
  (`from('subscriptions')…insert|update`) and the new writer speaks raw SQL over a direct connection.
  It stays, and is joined by an assertion that exactly one file imports `server/billing/db` and that
  it is the webhook route.
- **Deleting an account still cancels nothing.** ADR 0007 recorded the requirement; there is still
  no delete UI to hook it to, and CLAUDE.md's throwaway-account recipe deletes rows in the SQL editor
  where no application code can intervene. The recipe is amended to cancel the Stripe test
  subscription first, and the requirement is restated here as a prerequisite of any future delete
  flow: **cancel upstream, and only proceed on success.** No database constraint can enforce it —
  0024 chose the cascade over `on delete restrict` deliberately, to keep that recipe working.
- **The legal documents changed, and one of the changes was a pre-existing defect.** Both the Terms
  and the Privacy policy claimed you can delete your account from Settings, and no such control has
  ever existed; they now say deletion is by request. The Terms gain a refund sentence, because
  shipping a purchase control with nothing said about refunds is a gap somebody finds at the worst
  moment.
- **`billing_events` grows forever and nothing in this system can prune it.** There is no DELETE
  grant, on purpose: a writer that can delete can also cover its tracks. At this volume that is
  irrelevant for years, but it is a superuser job in perpetuity and nobody will remember.
- **The price is still one constant, and moving it now costs more than one edit.** ADR 0007 says
  changing `monthlyCents` is a single edit. Once prices exist at Stripe it is that edit *plus* a
  price migration, because a Stripe price amount is immutable: `pnpm billing:setup` creates a new
  price, transfers the lookup key, archives the old one, and warns loudly if anyone is subscribed to
  it — because archiving does not migrate existing subscribers, who keep paying the old amount
  forever, silently.
