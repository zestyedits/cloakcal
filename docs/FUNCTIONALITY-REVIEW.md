# CloakCal — everything it does, everything it does not, and everything nobody has checked

**Written 2026-08-16, for an outside reviewer.** Paste this whole file into a second set of
eyes and ask them to argue with it.

This is not marketing copy and it is not a design document. It is a complete, deliberately
unflattering description of a pre-launch product: what is built, what is deployed, what is
tested, and — the section that matters most — **what is untested, unverified, or known to be
wrong.** If you only read one section, read "What nobody has verified" near the end.

Sign-ups are **closed**. There are no real users. An independent security review is a hard
gate before public launch and **has not started**.

---

## 1. What the product is

A calendar where **event content is encrypted in the browser** and the server stores only
ciphertext for it. The product is not "a calendar with encryption bolted on" — the product is
**the ability to show different people different amounts of the same event**.

One event. Four audiences. Four different views of it, computed from one rule set:

| Audience | Sees |
|---|---|
| You | Everything |
| Your colleague | Title and time, not the location or the notes |
| Your dentist | Busy, 14:00 to 15:00, nothing else |
| A stranger | Nothing. The block is *absent*, not greyed out |

### The five rules that are the product

These are load-bearing. Each one is enforced by something automated, not by memory.

**1. CloakCal is NOT zero-knowledge, and is never marketed as such.**
The server stores, in plaintext: start time, end time, timezone, duration, recurrence rule,
which calendar an event belongs to, which occurrences were moved or cancelled, and workspace
membership. It does this because booking, reminders and conflict detection need them. It
stores **content** — title, location, notes, attendees — as ciphertext only.

The claim is *"other people cannot see this"*, not *"we cannot see anything"*. Product copy
says so in those words. A test forbids the strings `zero-knowledge` and `end-to-end` on the
plan page, and asserts the honesty paragraph is present.

**2. Server code cannot decrypt, and this is enforced statically.**
No module under `apps/` without a `'use client'` directive may import `@cloakcal/crypto` or
`@cloakcal/cloak-store`. `packages/cloak-store/src/server-boundary.leak.test.ts` scans for it
and fails the build. `e2e/leak.spec.ts` additionally fetches every route's HTML **and** its
React Flight payload from a live server and asserts no plaintext appears in either.

**3. `packages/policy` is the only place field visibility is decided.**
Server-side redaction and the client's "View As" call the same function on the same inputs. A
contract test runs the *same* JSON vectors through both entry points and asserts byte-identical
output. RLS is coarse row authorisation only.

**4. There is no service-role key anywhere.**
Every read and write runs as the signed-in user, under RLS. The one exception is a Postgres
role called `billing_writer` which holds privileges on exactly two tables (see §7) — that is
the narrow alternative to a service key, not a step toward one.

**5. No plaintext Tier B column exists.**
`events` has no `title` column. Content lives only in `cloaked_fields`, **one row per field**,
which is what makes "show the title but not the location" possible at all.

---

## 2. The data model

19 tables. What is plaintext and what is ciphertext is the single most important thing to
check in this document.

### Plaintext ("Tier A")

| Table | Holds | Why it is not encrypted |
|---|---|---|
| `workspaces` | owner, lifecycle, timezone, week start, default view, holiday region, keyboard prefs | Display framing; the server resolves the view before render |
| `events` | `start_utc`, `end_utc`, `timezone`, `all_day`, `rrule`, `exdates`, `busy`, `reminder_offsets`, `is_cloaked`, `lifecycle`, `version` | Booking, conflict detection and reminders need times |
| `calendars` | colour, position, lifecycle. **Name is ciphertext** | A colour is not content |
| `recurrence_exceptions` | which occurrence, and whether it was moved or cancelled | Keyed by local wall time |
| `visibility_rules` | which audience gets which level | The rule is not the content |
| `contact_group_members` | who is in which group | Structure, not identity |
| `availability_windows` | weekday + minute range | Free/busy is the point |
| `devices`, `root_key_wraps` | which devices can open the account, wrapped key material | Wrapped, not readable |
| `subscriptions` | plan, provider ids, renewal date | Billing |
| `audit_log` | what happened, never naming anything | Deliberately contentless |

**Explicitly acknowledged leak:** the *length* of a ciphertext leaks the length of its
plaintext. Padding to length buckets is designed and not built (§10).

### Ciphertext ("Tier B") — `cloaked_fields`

One row per field, per subject. Subjects are `event`, `calendar`, `contact`, `contact_group`.
Fields include `title`, `location`, `notes`, `attendees`, and contact/calendar names.

Contacts and groups carry **no** name, email or label column at all. That is a deliberate cost:
the server cannot answer "is this email address one of your contacts?", which booking will
eventually need. ADR 0004 records the options and rules out adding a plaintext column.

### The algorithm

AES-256-GCM. The version lives in the `cloak_alg` enum value itself (`aes-256-gcm-v1`) rather
than in a separate `format_version` column — a second copy of versioning is a second thing that
can drift. The client throws on an algorithm it does not implement, so the format is
fail-closed.

Key derivation is **Argon2id at m=65536, t=3, p=1** — 3.4× the OWASP memory floor, not at it.
`assertKdfParams` refuses any server-supplied weakening. Being above the floor matters here
specifically because the wrapped root key is servable to an offline attacker.

**The account email is the KDF salt.** Changing it is as destructive as losing a password: a new
address derives a different wrap key and the existing wrap stops opening, with no error saying
so. There is no email-change UI, and adding one without re-wrapping first would lock users out.
The password wrap records the `saltEmail` it was derived under so a mismatch is diagnosable.

---

## 3. Every user-facing flow

### Auth and keys

- **Sign up** → email confirmation → sign in → **first-run key ceremony**, which mints a root
  key and shows a **24-word recovery phrase**.
- Signing up with an address that already has an account **sends nothing and returns success**.
  That is deliberate: a form saying "that address is taken" is an account-enumeration oracle,
  and for this product "does this person use a privacy calendar" is often more sensitive than
  any event in it. A test forbids branching on the documented tell.
- **Unlock** on each new session. Keys live in IndexedDB, non-extractable.
- **Passkeys** wrap the same root key via WebAuthn PRF. Registration triggers **two biometric
  prompts** back to back, because PRF output is not reliably returned from `create()` (Safari
  returns `enabled: true` and no results), so the code creates then immediately asserts. The
  copy says so, or it reads as the first prompt having failed.
- **Recovery**: `/recover` takes either the 24 words or a passkey, plus a new password, and
  **re-wraps** the root key rather than re-encrypting anything.
- **The phrase can be re-issued** from `/account`, proved with the password or the current
  phrase. Before that existed, losing the paper while still signed in left the account already
  unrecoverable and looking completely fine — which is worse than never writing it down,
  because there is no signal until the day it cannot be fixed.
- **Removing a passkey refuses when it is the last way in.** Matters most for OAuth accounts,
  which have no password wrap.

### The calendar

- Four views: **agenda, week, day, month**, via `?view=` + `?date=`. Agenda and week are one
  fetch with an instant client toggle; day and month are server navigations.
- Month fetches the visible **42-day grid**, so leading cells cannot render empty while events
  exist on them.
- **Keyboard**: `t` today, `←`/`→` or `k`/`j` step, `1`–`4` views, `n` new event, `?` help.
  Single keys, no modifiers, matching what Google Calendar and Fastmail trained everyone on.
  The guard order is the contract: a handled event, any modifier, IME composition, focus inside
  text entry, or **any open `dialog`** all mean the key is not ours.
- **Availability windows** shade the hours outside them. The overlap rule is data hygiene, not
  a security boundary — the RPC is SECURITY INVOKER, so the caller necessarily holds INSERT and
  could write overlapping rows directly. The read path merges rather than trusting.
- Holidays by region.

### Events

- Create, edit, delete, with per-field encryption on write.
- **Recurrence is wall-clock, deliberately diverging from RFC 5545 §3.3.10.** "09:00 every
  Tuesday" stays 09:00 across a DST shift. The local wall time is authoritative and instants are
  derived. Documented in ADR 0001 rather than hidden.
- **Series splits**: editing a repeating event asks *this one* / *this and all following* /
  *all of them*. The first two go through `split_cloaked_event`.
- Split verification is deliberately **in two halves**: the client proves the *plan* is lossless
  before the call, and the RPC proves what was *stored* is that plan, byte for byte, inside the
  transaction. Together: `expand(stored) == expand(original)`. Postgres has no RFC 5545 engine,
  and a second implementation in plpgsql would disagree with the first on a DST boundary.
- Retiming is offered under a split scope and **withheld for the whole series**, because moving
  a series anchor would strand every `recurrence_exceptions` row on the old wall time.
- **Deleting one occurrence** works and defaults to the smaller blast radius. *"This and all
  following"* is deliberately **not** offered on delete: it is a truncation rather than a
  subtraction, a wrong `UNTIL` silently eats the occurrence the user was standing on, and there
  is no equivalent of the split's losslessness proof for the delete path.

### Privacy and sharing

- **Visibility rules** per contact and per group, set from a per-event sheet or from Settings.
- **View As** renders the calendar as a chosen audience would see it, using the real stored
  rules through the real engine.
- Every agenda row and week block carries a **privacy chip** showing the *widest* disclosure any
  non-owner audience gets. Month deliberately carries none, at 84-cell density.
- **Contact names are ciphertext**, so the audience picker cannot be labelled by the server.
  Before unlock it shows `Contact 4f2a…`, which is what the server actually sees.
- **Nothing can be sent to anyone.** `access_envelopes` is unused. There is no share link, no
  booking page, and no invitation. The `public` audience is real in the engine but there is no
  link for it to describe.

### Settings

Five cards plus `/settings/security`, `/settings/availability` and `/settings/plan` as their own
routes. Appearance, time & region, calendars, people & sharing, availability, security, plan.

### Billing (new, and off everywhere)

See §7. Behind a fail-closed flag; test mode only, enforced by code.

---

## 4. What is *not* built

Stated plainly, because a features list that omits this is a sales document.

- **Booking pages.** Nothing books itself. `route_token` exists in the schema and is dead.
- **External calendar sync.** No CalDAV, no Google, no Apple, no OAuth to anything.
- **Shared calendars.** ADR 0003 pins single-owner.
- **Automations and reminders.** `reminder_offsets` has been on `events` since migration 0001
  and **nothing ever reads it to send anything.** There is no scheduler and no notification code.
- **Export.** `packages/domain/src/ical.ts` exists; there is no UI. It is promised as free
  permanently.
- **Account deletion.** There is no control. It is done by hand in the Supabase SQL editor.
  Both legal documents claimed you could do it from Settings until 2026-08-16; they now say it
  is by email, which is true.
- **Device pairing UI.** The ECDH crypto and schema are done, tested, and unused.
- **Calendar delete**, and moving an event between calendars.
- **Native iOS/Android.** Web only.
- **Teams, CRM.**

---

## 5. The privacy engine

`packages/policy` — pure, no I/O.

- **Field visibility** is `visible | hidden` per field.
- **Time visibility** is `exact | busy | hidden`.
- **Audience kinds** are `owner | individual | group | public`.
- A partial unique index makes two rules for one audience unrepresentable.

**Hidden means ABSENT, not dimmed.** A hidden event does not render a greyed block; it does not
render at all. That is a deliberate design decision carried through the landing page's hero,
the week grid and the agenda: a placeholder that says "something is here but you cannot see it"
leaks the thing it is hiding.

**Rules have no version guard**, deliberately breaking the house RPC pattern. A rule is a row you
overwrite by choosing a different radio button; last-write-wins *is* the semantics, and a version
column would put "someone else changed this, reload" in front of a double-click.

---

## 6. Security posture

### RLS and grants

Every table has RLS **enabled and forced**. Every RPC is `SECURITY INVOKER` — a sweep forbids
`SECURITY DEFINER` outright. Each RPC is version-guarded and audited without naming anything.

Four traps this project has already paid for, all now guarded by automated sweeps:

1. **Every new function is executable by `anon` by default, and there is no way to change it.**
   Two separate grants exist and each hides the other: Supabase runs `alter default privileges …
   grant all on functions to anon`, *and* Postgres separately grants EXECUTE to PUBLIC at
   creation. The second **cannot be turned off** — the revoke that looks like the fix is a silent
   no-op. Every function must write both `revoke all on function … from public` and `… from
   anon`. A sweep in `security-posture.test.ts` fails if any function in `public` is executable
   by `anon`. It has already caught one.

2. **TRUNCATE was granted to `anon` on all sixteen tables, and RLS does not filter TRUNCATE.**
   Supabase's default ACL for a new public table is `arwdDxtm` for both roles. There is no
   per-row decision for a policy to make, so `force row level security` plus `using (false)` does
   not stop it — only the absent privilege does. Latent rather than open (PostgREST exposes no
   TRUNCATE verb, `anon` is NOLOGIN), but the blast radius was the whole database.
   `0025_revoke_truncate.sql` removed TRUNCATE, REFERENCES, TRIGGER and MAINTAIN from both roles.
   **MAINTAIN is the lesson**: new in PostgreSQL 17, arrived pre-granted, and *subtracting the
   verbs you thought of cannot survive a verb you have not heard of.* Write revokes as
   allowlists.

3. **A column-level revoke is a silent no-op** while a table-level grant stands. Verified on
   PGlite, not reasoned about. This is why the plan lives in its own table rather than as a
   column on `workspaces` — a Postgres policy is *row*-level and cannot name a column.

4. **The test harness was a stricter fiction than production**, granting four of eight privileges
   under a comment claiming it mirrored Supabase — on precisely the axis a hardening migration is
   tested for.

### Content Security Policy

A per-response nonce, built by a pure function so the *production* policy can be asserted without
a server. Playwright runs `next dev`, which is deliberately looser, so the browser suite only
ever sees the weak policy.

```
script-src  'self' 'nonce-…' 'strict-dynamic'     (no unsafe-inline, no unsafe-eval)
style-src   'self' 'unsafe-inline'                (Next inlines critical CSS; not nonce-able)
frame-src   'none'
form-action 'self'
frame-ancestors 'none'
connect-src 'self' <supabase origin> wss://<supabase host>
```

`connect-src` names the Supabase origin and **nothing in the test suite can verify that** — the
fixture never calls Supabase, so a wrong origin passes every test and breaks every real account
on its first query, as an opaque network error.

The CSP is applied **above** middleware's dev-unlock early return, and a test pins that order.

### Headers

`X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
`Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`.

### Auth

`supabase.auth.getClaims()`, never `getSession()`, on the server — the session cookie is
client-writable, so trusting it would let anyone hand us a forged user id.

Supabase's own error text is **never** forwarded to a user. Its PKCE failure reads *"PKCE code
verifier not found in storage… For SSR frameworks (Next.js, SvelteKit, etc.), use @supabase/ssr
on both the server and client"* — advice for whoever built the app, shown to someone who clicked
a link in their email. Failures map to slugs and the form owns the copy.

---

## 7. Billing (added 2026-08-16 — the newest and least proven code here)

**Pricing:** Free $0. Pro $8/month or $72/year. Free is *everything CloakCal does today*, because
the binding rule is that basic privacy is never paywalled and cloaking is the whole shipped
product. Pro's "includes" list is **empty on purpose**; its four planned items (booking, external
sync, shared calendars, automations) are all unbuilt.

**No published limits on either tier.** Nothing counts anything, and the browser holds a real
PostgREST token, so a limit inside an RPC is decoration.

### The one architectural line

> **Entitlement comes from `subscriptions.plan` and nothing else, ever. The renewal date,
> cadence, card and invoices are read from Stripe at render time and grant nothing.**

A test asserts a healthy Stripe response cannot promote a free account. If that ever fails, the
paywall has acquired an outbound HTTP call and fails *open* when Stripe is slow.

### Management is on our domain

Cancel, resume and monthly↔yearly switch are Subscriptions API calls from our own route handler,
rendered on `/settings/plan`. Only **updating a card** redirects to Stripe's portal — taking a
card number on our own domain needs Stripe.js in a bundle whose entire threat model is that XSS
equals total compromise, and would require prising open `frame-src`, `connect-src` and
`Permissions-Policy: payment=()`.

Cancel is always `cancel_at_period_end`, never immediate: a cancelled subscription is **terminal**
at Stripe and cannot be reactivated.

### How the webhook writes without a service-role key

A dedicated Postgres role, `billing_writer`, connecting over the transaction pooler. It holds
`select, insert, update` on `subscriptions`, `select, insert` on `billing_events`, and **nothing
else** — a test runs *as the role* and proves it cannot read `workspaces`, `events`,
`cloaked_fields` or `auth.users`. **No DELETE anywhere**, because a writer that can delete can
also cover its tracks; a cancellation is an UPDATE to `plan = 'free'`.

Its policies are `using (true)` — a webhook has no session, so RLS cannot scope by row. That moves
the integrity control to the customer→workspace mapping, which is the **only** thing between a bug
and a plan written onto the wrong account.

**The mapping:** the workspace id reaches Stripe exactly once, as `client_reference_id` on the
Checkout Session, from an authenticated session. It is uuid-validated on the way back. Every later
event resolves customer→workspace from `subscriptions` alone.

**The account email is never sent to Stripe**, because it is the KDF salt. Stripe collects a
billing email itself, which has the side effect that your billing address need not be the address
you sign in with.

### The webhook transaction

1. Claim the event id (`on conflict do nothing returning`) — **inside** the transaction. If it
   committed separately and the write then failed, the retry would find the id present, conclude
   the work was done, and the plan would never land.
2. Take `select … for update` on the row — **before** the Stripe call. Re-fetching from the API
   fixes stale payloads; it does nothing about two handlers racing.
3. Re-fetch from Stripe. Never trust the payload.
4. Upsert.

### Fail-closed by construction

`billingConfig()` returns null unless **all six** server-only variables are present and
well-formed, and **refuses any key that is not `sk_test_`**. Pasting a live key into Vercel
therefore *disables* billing. It also refuses the literal `[SENSITIVE]`, which is what
`vercel env pull` writes for a Sensitive variable while exiting 0.

---

## 8. What is tested

- **1249 unit tests** across 12 vitest projects.
- **460 Playwright tests** across phone, desktop, a11y and visual projects.
- **PGlite** (WASM Postgres, no Docker) runs the real migrations and the real RLS policies, so
  the DB tests cover the production path rather than an approximation of it.
- **Leak tests** fetch every route's HTML *and* Flight payload from a live server and guard the
  bodies are non-empty first.
- **Contract tests** run shared JSON vectors through the server and client policy entry points
  and require byte-identical output.
- **axe** on 15+ pages, in **both themes**. The light theme had never been scanned until
  2026-08-15 and was carrying four separate AA failures.
- **Contrast pairs** are computed against *composited* colours, hex by hex, in both themes.
- **44px touch-target sweeps** and **390px no-sideways-scroll guards** on the pages that have
  earned them.
- **Source sweeps** as a category: no client-side write to `subscriptions`; no second button
  system; no bare `var()` naming an undeclared property; every API route gated or allowlisted
  with a written reason; no em dash in any user-facing string.

`pnpm build` must run **before** `pnpm test` on a fresh clone: a build-output gate inspects the
prerendered output and **fails rather than skips** when no build is present, deliberately,
because a privacy gate that skips reports green while checking nothing.

---

## 9. What nobody has verified

**Read this section first if you are reviewing.** Everything above is either automated or was
checked in a browser. Everything below is not.

### Never met a real service

1. **Stripe has never been contacted.** No key exists. Checkout has never run, no webhook has
   ever been delivered, no card has ever been charged, and no plan has ever flipped as a result
   of a payment. Every billing test is source-level, PGlite, or a fabricated fixture.
2. **`billing_writer` has no password and has never connected.** Migration 0028 created it
   `NOLOGIN` deliberately. The **Supavisor username convention for a custom role**
   (`billing_writer.<project-ref>`) is inferred from documentation and unverified against this
   project. **If it is wrong, every webhook 500s — after Checkout has already succeeded, so
   somebody has paid and is sitting on Free.** PGlite proves the SQL and proves nothing about
   the wire.
3. **No real authenticator has ever produced a WebAuthn PRF output.** Every passkey test is
   source-level or mocked. Safari's PRF behaviour and the two-prompt flow are unverified.
4. **`connect-src` naming the Supabase origin cannot be tested here.** The fixture never calls
   Supabase.

### Silent failure modes with no detector

5. **A wrong webhook signing secret disables the endpoint, and the app looks perfect.** Every
   delivery 400s, Stripe retries for days, then disables it. Nothing in the product looks wrong,
   because absence of a subscription row means Free — the property that makes a missing row
   *safe* is the same property that hides this. The only watchdog is a status line printed by
   `pnpm billing:setup`.
6. **`current_period_end` moved onto subscription *items*** in Stripe's `flexible` billing mode.
   A wrong read stores `null` forever, no constraint fires, and the page says "renews —" for the
   life of the account.
7. **Deleting a workspace destroys the subscription row while the processor keeps charging.** The
   cascade is deliberate; `on delete restrict` would break the test-account recipe. **No database
   constraint can enforce the ordering**, and there is no delete UI to hook it to.
8. **A test-mode `plan = 'pro'` row is indistinguishable from a live one** and can outlive test
   mode. `subscriptions` has no `livemode` notion. Clearing the table is a manual launch step.
9. **Ciphertext length leaks plaintext length.** Padding is designed, not built.
10. **`billing_events` grows forever** and nothing in the system can prune it — there is no DELETE
    grant, on purpose. It is a superuser job in perpetuity.

### Process and infrastructure

11. **CI does not gate the deploy.** Vercel auto-deploys `main`; `ci.yml` has no deploy step, so
    the two race. `main` once spent five commits red while shipping every one of them.
12. **Branch protection is unavailable**, not merely off: the repo is private on a free GitHub
    plan and the API returns 403. The only gate is whoever runs `git push`.
13. **Visual baselines exist for macOS only.** CI is Ubuntu, so the visual project **skips there**
    and checks nothing until a Linux baseline is generated and committed. Until 2026-08-11 every
    committed baseline was Windows and the suite had never run anywhere.
14. **Screenshot diffs catch layout, not colour.** Repointing a brand colour at red measured 0.04%
    of the page and passed.
15. **Migrations are applied by hand** while code deploys on push, so the two always disagree for
    a window. Code tolerates an unapplied migration; schema-ahead-of-code has no safety net.
16. **The Supabase MCP tools are denied entirely**, read-only calls included. Verifying a migration
    landed is done by probing PostgREST error codes.

### Gaps a reviewer should push on

17. **No rate limiting anywhere**, on any endpoint, including the billing routes and auth.
18. **No CAPTCHA, no bot defence** on sign-up. Currently mitigated only by sign-ups being closed.
19. **No monitoring, alerting, or error reporting.** No Sentry, no uptime check. A disabled webhook
    endpoint or a 500-ing route would be noticed by a person, eventually.
20. **No backup or restore procedure has ever been tested**, and there is no key-escrow story: if a
    user loses both their password and their phrase, their content is permanently unreadable by
    anyone including us. That is the design, and it is stated in the Terms.
21. **The keyboard-shortcut opt-out exists**, but WCAG 2.1.4 conformance is *claimed as a recorded
    gap* rather than as conformance.
22. **The privacy chip's raw colours are shape colours only** — one of them measures 1.32:1 as ink
    by design. Nothing may render a raw privacy colour as text, and only a source rule enforces
    that.
23. **`is_cloaked` is a plaintext boolean on `events`.** It tells the server which events have
    hidden content. That is intentional (notification wording), and it is metadata about privacy
    that the server can see.

---

## 10. Designed and not built

- Padding sealed fields to length buckets, so ciphertext length stops leaking content length.
- Binding plaintext times into the AES-GCM AAD, so the server can see times but not forge them.
- A per-calendar key layer, and `access_envelopes`, for real sharing. **Note:** sharing splits by
  disclosure level, and the `busy` and `hidden` levels emit no ciphertext at all — so a booking
  page and a busy-level share link need **no new crypto**. Only `limited` and `full` do.
- `deriveFieldKey` currently returns a **non-extractable** key, so envelope material cannot be read
  out of it. That is the next crypto change and it needs an ADR.

---

## 11. Questions worth asking a reviewer

1. Is "not zero-knowledge, and here is exactly what we can see" a defensible position for a
   privacy calendar, or does storing times, durations and recurrence in plaintext undermine the
   pitch enough that the honest framing does not save it?
2. `billing_writer` is a real deviation from "every query runs as the signed-in user". Is a
   single-table role with `using (true)` policies and no DELETE genuinely narrower than a service
   key, or is that a distinction without a difference?
3. The webhook holds a Postgres transaction open across a Stripe API call, to take a row lock
   before fetching. Is that trade right, or should it use a monotonic watermark column instead and
   accept a stale read?
4. Is the account email being the KDF salt a mistake that should be fixed before any real user
   exists? Migrating later means re-wrapping every account.
5. Is "hidden means absent" right? It is unambiguous, and it also means a viewer cannot tell the
   difference between "nothing scheduled" and "something you may not see" — which is the point,
   but it also makes scheduling around someone harder.
6. What is missing from §9 that should be there?
