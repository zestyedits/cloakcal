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
pnpm test                # 502 unit tests
pnpm test:e2e            # 51 Playwright tests, runs its own dev server
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

---

## Current state, honestly

**Works:** sign up, sign in, first-run key ceremony with a 24-word recovery phrase, unlock,
agenda and week views, week navigation, View As, creating an encrypted event, deleting one.
Verified end to end in a browser against the live Supabase project, not just in tests.

**The biggest gap:** `packages/db` is still imported by nothing. The CRUD service — five
enforced gates, three edit scopes, atomic series splits, optimistic concurrency, unskippable
post-write verification — is fully tested against PGlite and wired to no UI. It is being
ported to Supabase RPCs one mutation at a time.

**Ported so far:** `create_cloaked_event` (0007) and `trash_cloaked_event` (0008). Both are
SECURITY INVOKER, so RLS decides what they can touch. Trash is version-guarded, soft (the row
and its cloaked fields survive), and audited without naming anything.

**So: you can create and delete an event, but not edit one.** Editing is the top job, and it
is the hard part — three scopes, atomic series splits, post-write verification. Follow the
shape 0008 established: one RPC, invoker rights, an expected version in, a distinguishable
error out.

**Delete is whole-series.** A recurring event is one row, so trashing it removes every
occurrence, and the confirmation says so. Per-occurrence deletion needs the
`recurrence_exceptions` path from `packages/db`, which lands with the edit port.

**Then, in order:**
1. Password change / rewrap. Changing a Supabase password today leaves the old wrap in place
   and locks the user out permanently. Actively dangerous; must land before any real user.
2. Read `visibility_rules` from the database. `apps/web/src/server/audience.ts` uses
   hardcoded demo rules, so View As currently demonstrates the engine rather than
   controlling anything.
3. Device pairing UI. The crypto and schema are done and tested; there is no flow.
4. Day and month views — currently disabled controls, honestly labelled.

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
- **`revoke ... from public` does NOT lock a function to signed-in callers.** Supabase runs
  `alter default privileges ... grant all on functions to anon, authenticated, service_role`,
  so every new function carries an EXPLICIT grant to `anon` that a revoke from `PUBLIC` does
  not touch. 0007 and 0008 both got this wrong; 0009 fixes them and revokes the default, so
  new functions are safe by default. The db harness now creates a real `anon` role — use
  `db.asUnauthenticated(...)`, not `db.asAnon(...)`, for privilege assertions. `asAnon` is
  the `authenticated` role without a subject, which is a different thing entirely.

## Working style

Match the surrounding code: this repo comments the *why*, especially where a decision looks
odd or diverges from a standard. If you discover a real defect while working, fix it and say
so plainly rather than working around it. If a test is inconvenient, that is usually the
test doing its job — weakening a guarantee to make a test pass is how guarantees stop being
real.
