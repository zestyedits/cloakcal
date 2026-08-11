# CloakCal — working notes

Read this before touching anything. It is the shortest path to being useful on this repo,
and it is loaded automatically at the start of every session.

**What it is:** a privacy-first calendar. Event content is encrypted in the browser; the
server stores ciphertext and can never read it. The product is the ability to show different
people different amounts of the same event.

**Full spec:** `CLOAKCAL_MASTER_ARCHITECTURE.md`. **Binding decisions:** `docs/decisions/`.
**State at each milestone:** `docs/M0-REVIEW.md`, `M1-REVIEW.md`, `M3-REVIEW.md`.

---

## The five rules that are not negotiable

Everything else is a preference. These are the product.

**1. CloakCal is NOT zero-knowledge, and must never be marketed as such.**
The server stores times, durations, recurrence and calendar membership in plaintext, because
booking, reminders and conflict detection need them (plan D1). It stores *content* — title,
location, notes, attendees — as ciphertext only. The privacy claim is "other people cannot
see this", not "we cannot see anything". Say so plainly in product copy.

**2. Server code cannot decrypt, and this is enforced statically.**
No module under `apps/` without a `'use client'` directive may import `@cloakcal/crypto` or
`@cloakcal/cloak-store`. `packages/cloak-store/src/server-boundary.leak.test.ts` scans for
it and fails the build. Plaintext must never cross back out to an RSC/Flight payload, server
action argument, log, analytics event, error report, URL, or Next's data cache.

**3. `packages/policy` is the only place field visibility is decided.**
Server redaction and the client's "View As" call the same function on the same inputs, and a
contract test asserts they produce byte-identical output. RLS is coarse row authorisation
only — if you find yourself writing a Postgres policy that inspects `fields` or reasons
about an audience, stop; that logic belongs in the engine (plan D2).

**4. There is no service-role key anywhere, and there must never be one.**
It bypasses RLS entirely. Every read and write runs as the signed-in user, which is why the
RLS tests in `packages/db` cover the production path rather than an approximation of it.

**5. No plaintext Tier B column exists, and adding one is a review failure.**
`events` has no `title`. Content lives only in `cloaked_fields`, one row per field, which is
what makes "show the title but not the location" possible at all.

## Two more, slightly less absolute

**Wall-clock recurrence.** "09:00 every Tuesday" stays 09:00 across a DST shift. The local
wall time is authoritative and instants are derived from it. This deliberately diverges from
RFC 5545 §3.3.10 — see `docs/decisions/0001-recurrence-dst.md`, which documents the
divergence rather than hiding it. **Never wrap a `dtstart_local` value in `new Date()`**;
that reintroduces the host timezone and silently breaks the guarantee.

**The dev flag.** `NEXT_PUBLIC_CLOAKCAL_DEV_UNLOCK=1` governs three things together: serving
the committed fixture, unlocking it with a published seed key, and bypassing the auth
middleware. All three also check `NODE_ENV !== 'production'`, which Next inlines at build
time, so a production bundle cannot reach any of them. Do not split them apart.

---

## Where things are

```
apps/web/                Next.js 15 App Router
  src/lib/               client-side: supabase clients, cloak-session (auth + keys)
  src/server/            server-only: events read path, policy application, week ranges
  src/components/        UI. Anything touching a key is 'use client'.
packages/policy/         THE visibility engine + shared JSON vectors
packages/crypto/         Cloak boundary: AES-GCM, HKDF, key wrapping, recovery, pairing
packages/cloak-store/    Browser-only decryption store + IndexedDB key vault
packages/domain/         Recurrence, DST, edit scopes, iCalendar. Pure, no I/O.
packages/db/             Migrations + CRUD service, tested against PGlite (no Docker)
tools/                   email-setup (Resend/Porkbun/Supabase), fixture generator
```

## Commands

```bash
pnpm dev                 # localhost:3000, needs apps/web/.env.local
pnpm build               # production build to .next-prod. RUN THIS BEFORE pnpm test.
pnpm test                # 638 unit tests
pnpm test:e2e            # 74 Playwright tests, runs its own dev server
pnpm typecheck           # covers .ts AND .tsx
pnpm email:setup         # Resend + DNS + Supabase SMTP, idempotent
```

**`pnpm build` comes before `pnpm test` on a fresh clone.** `build-output.leak.test.ts`
inspects the prerendered HTML and RSC payloads in `apps/web/.next-prod`, and with no build
present it FAILS rather than skips — deliberately, because a privacy gate that skips reports
green while checking nothing. One failed suite on a clean checkout is that gate working, not
a broken tree.

To run the app with no account, using the committed fixture:
`NEXT_PUBLIC_CLOAKCAL_DEV_UNLOCK=1 pnpm dev`

**Testing auth or recovery against the live project needs a throwaway account, and email
confirmation is ON, so signing up is not enough on its own.** Sign up through the UI with any
`@cloakcal.test` address, then confirm it by hand:

```sql
update auth.users set email_confirmed_at = now() where email = '<the address>';
```

Sign in to run the key ceremony, and keep the 24 words the screen shows — recovery cannot be
tested without them. Delete the account afterwards with
`delete from auth.users where email like '%@cloakcal.test'`; the cascade takes its events,
wraps and workspace with it. **Do not leave one lying around and do not commit its password.**
A known credential on the production project is worth less than this recipe.

---

## Current state, honestly

**Works:** sign up, sign in, first-run key ceremony with a 24-word recovery phrase, unlock,
agenda and week views, week navigation, View As, and the full create / edit / delete loop on
an event. Plus account recovery: `/recover` takes the phrase and a new password, `/account`
changes a password deliberately, and both re-wrap the root key rather than re-encrypting
anything. Verified in a browser, not just in tests.

**Ported to RPCs so far:** `create_cloaked_event` (0007), `trash_cloaked_event` (0008),
`update_cloaked_event` (0011), `split_cloaked_event` (0013). All SECURITY INVOKER, so RLS
decides what they can touch; all version-guarded; all audited without naming anything. Follow that shape for the next one —
one RPC per user action, an expected version in, a distinguishable slug out.

**Series splits work.** Editing a repeating event asks which occurrences to change — this
one, this and all following, or all of them. The first two go through `split_cloaked_event`;
the third is the ordinary update. Retiming is offered under a split scope and withheld for
the whole series, because moving a series anchor would strand every `recurrence_exceptions`
row on the old wall time (`update_cloaked_event` still refuses it, loudly).

**How split verification is split in two, and why.** `packages/db`'s gate 3 re-expands the
STORED series and compares occurrence sets. The RPC cannot: that needs an RFC 5545 engine,
Postgres has none, and a second implementation in plpgsql would disagree with the first on a
DST boundary. So `apps/web/src/lib/split-plan.ts` proves the PLAN is lossless before the call
(3a) and 0013 proves what was STORED is that plan, byte for byte, inside the transaction
(3b). Together: `expand(stored) == expand(original)`. Do not "simplify" either half away —
3a alone reasons about a plan that may not have survived the trip, 3b alone faithfully
stores a bad idea.

**A retiming split cannot check the occurrence set**, since moving the event is the point.
It checks two weaker things instead, and the non-obvious one is that the successor must
START where the user put it: move a `BYDAY=TU` series to a Wednesday and rrule keeps
generating Tuesdays, so the stored anchor disagrees with the dates that render. The
occurrence COUNT is unchanged, so only the start check can see it.

**Known wart:** splitting at the FIRST occurrence of a series leaves the original truncated
to nothing — a row that produces no occurrences. Lossless and harmless, but it should
collapse into a plain whole-series edit instead of leaving a dead row behind.

**Deleting is still whole-series.** `recurrence_exceptions` now has everything a
per-occurrence delete needs (0013 writes and migrates them); the UI has not been wired.

**Then, in order:**
1. Read `visibility_rules` from the database. `apps/web/src/server/audience.ts` uses
   hardcoded demo rules, so View As currently demonstrates the engine rather than
   controlling anything.
2. Device pairing UI. The crypto and schema are done and tested; there is no flow.
3. Day and month views — currently disabled controls, honestly labelled.

**Deferred by design:** booking, payments, CRM, automations, external calendar sync, teams,
native iOS. **Independent security review is a hard gate before public launch.**

---

## Things that will waste your time if you do not know them

- **`next` is a root devDependency purely for Vercel's framework detection.** It is never
  executed from there. See `docs/deploy.md`.
- **Visual baselines are per-platform.** The `visual` Playwright project skips itself on any
  OS with no committed baselines. Generate with `pnpm test:visual --update-snapshots` and
  commit them.
- **PGlite parses `timestamp without time zone` using the host timezone.** The db tests ask
  Postgres for `to_char(...)` text instead. Do not "simplify" that back to a Date.
- **Secrets do not travel between machines, by design.** On a fresh clone run
  `vercel env pull apps/web/.env.local`. `.env.email-setup` is setup-only.
- **`vercel env pull` can succeed and still give you nothing usable.** It targets the
  *development* environment by default, and it renders any variable typed `Sensitive` on
  Vercel as the literal string `[SENSITIVE]` rather than its value — while still printing
  `✓ Created` and exiting 0. That is worse than failing: `supabaseBrowser()` only throws when
  a variable is `undefined`, so a `[SENSITIVE]` placeholder sails past the loud-failure guard
  and surfaces later as an inexplicable network error. If `.env.local` looks wrong, read it
  before trusting the exit code. Both Supabase values are public by design (see
  `docs/deploy.md`) and can always be re-sourced from the Supabase dashboard.
- **`supabase.auth.getClaims()`, not `getSession()`, on the server.** The session cookie is
  client-writable; getClaims verifies the JWT signature.
- **The account email is the KDF salt, so changing it is as destructive as changing a
  password.** `deriveMasterSecret` salts with the normalized email, which means a new address
  derives a different wrap key and the existing wrap stops opening — with no error that says
  so. There is no email-change UI, and adding one without re-wrapping first would lock every
  user who used it out of their own content. The password wrap's `kdf` jsonb now records the
  `saltEmail` it was derived under, so a mismatch can be diagnosed rather than guessed at.
  `packages/crypto/src/rewrap.test.ts` pins the consequence.
- **Two path lists in `middleware.ts`, and they are not the same question.** `PUBLIC_PATHS`
  is "reachable without a session"; `SIGNED_IN_ELSEWHERE` is "pointless once you have one".
  `/recover` is in the first and deliberately NOT the second, because the emailed recovery
  link works by CREATING a session and landing back on `/recover` — a blanket "signed in? go
  home" redirected the user away a fraction of a second before they could type their phrase,
  making recovery unreachable in exactly the case it exists for while looking correct signed
  out. Caught in a browser, never by a test; `middleware-paths.server.test.ts` now guards it.
- **Send temporal values to an RPC as TEXT, never as `timestamp`.** Postgres silently drops a
  timezone offset when parsing into `timestamp without time zone`, so a client that sent
  `zoned.toString()` instead of `local.toString()` would store an anchor hours off with no
  error — and a read-back check comparing against the same typed parameter would compare two
  copies of the same lossy parse and pass. `private.canonical_local` / `canonical_instant`
  regex-validate first, which makes the cast total.
- **axe measures COMPOSITED colour, so never run it mid-animation.** The event sheet rises
  over `--duration-base`; analysing at opacity 0 reports every label as a contrast failure
  against a box that is not painted yet, and it looks exactly like a palette bug. `openSheet`
  in `e2e/edit-event.spec.ts` waits on `getAnimations()` rather than sleeping, which also
  stays correct under prefers-reduced-motion.
- **A dialog effect must not `close()` in its cleanup.** React re-runs effects in development
  (effect → cleanup → effect) and `close()` dispatches a `close` event, so the sheet calls
  `onClose` and shuts itself the instant it opens — in dev only, which is the worst place for
  a bug to live. Unmounting releases the top layer on its own.
- **Every new function is reachable by logged-out callers, and there is no way to change the
  default.** Two separate grants of `EXECUTE` exist and each hides the other. Supabase runs
  `alter default privileges ... grant all on functions to anon, ...` — an explicit `anon`
  grant that `revoke ... from public` does not touch, and the hole 0007 and 0008 shipped
  with. Postgres *separately* grants `EXECUTE` to `PUBLIC` on every function at creation, and
  `anon` inherits through `PUBLIC`. **The second one cannot be turned off**: `alter default
  privileges ... revoke execute on functions from public` looks like the fix and is a silent
  no-op, because the built-in grant is implicit rather than a stored default. Verified on the
  live project, not inferred. So 0009's claim that it made new functions "safe by default"
  was wrong and will stay wrong. Write **both** `revoke all on function ... from public` and
  `... from anon` on every new function, and trust the sweep in
  `packages/db/test/security-posture.test.ts` — it fails if any function in `public` is
  executable by `anon` — rather than trusting your reasoning about grants. It already caught
  one (`touch_updated_at`, fixed in 0010). Use `db.asUnauthenticated(...)`, not
  `db.asAnon(...)`, for privilege assertions: `asAnon` is the `authenticated` role without a
  subject, which is a different thing entirely.

## Working style

Match the surrounding code: this repo comments the *why*, especially where a decision looks
odd or diverges from a standard. If you discover a real defect while working, fix it and say
so plainly rather than working around it. If a test is inconvenient, that is usually the
test doing its job — weakening a guarantee to make a test pass is how guarantees stop being
real.
