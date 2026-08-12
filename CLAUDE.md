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
    cloak-mark.ts        THE logo geometry, as a string. No JSX, no CSS import.
    cloak-logo.tsx       <CloakLockup>, the only brand markup in the app.
  src/app/fonts/         Inter v4.1, self-hosted. Checksum in docs/brand.md.
packages/policy/         THE visibility engine + shared JSON vectors
packages/crypto/         Cloak boundary: AES-GCM, HKDF, key wrapping, recovery, pairing
packages/cloak-store/    Browser-only decryption store + IndexedDB key vault
packages/domain/         Recurrence, DST, edit scopes, iCalendar. Pure, no I/O.
packages/db/             Migrations + CRUD service, tested against PGlite (no Docker)
tools/                   email-setup (Resend/Porkbun/Supabase), fixture generator,
                         render-brand-assets (icons; output committed)
```

## Commands

```bash
pnpm dev                 # localhost:3000, needs apps/web/.env.local
pnpm build               # production build to .next-prod. RUN THIS BEFORE pnpm test.
pnpm test                # 757 unit tests
pnpm test:e2e            # 91 Playwright tests, runs its own dev server
pnpm typecheck           # covers .ts AND .tsx
pnpm email:setup         # Resend + DNS + Supabase SMTP, idempotent
pnpm brand:assets        # regenerate every icon from cloak-mark.ts. Commit the output.
pnpm email:templates     # write the branded emails to .email-preview/ to read or paste
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

**The brand is real now.** There is an actual mark — a calendar tile with a cloak over its
lower-right corner, where the dates under the cloak are ABSENT rather than dimmed — replacing
the 32px gradient square that stood in for a logo, and the eleven lines of markup that were
copy-pasted into four components. Favicon, `.ico`, apple icon, PWA tiles and a social card all
generate from that one SVG. Inter is loaded for the first time. `docs/brand.md` records which
parts of the mark the references specify and which are extrapolated.

**Ported to RPCs so far:** `create_cloaked_event` (0007), `trash_cloaked_event` (0008),
`update_cloaked_event` (0011), `split_cloaked_event` (0013), `cancel_occurrence` (0014). All
SECURITY INVOKER, so RLS decides what they can touch; all version-guarded; all audited without
naming anything. Follow that shape for the next one — one RPC per user action, an expected
version in, a distinguishable slug out.

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

**Deleting one occurrence works.** The confirmation on a repeating event asks "only this
one" or "the whole series", and defaults to the smaller blast radius. The first goes through
`cancel_occurrence` (0014), which writes a `kind = 'cancelled'` exception keyed by local wall
time; the second is the existing trash. The read path has honoured cancelled rows since M1 —
nothing had ever written one.

**"This and all following" is deliberately NOT offered on delete.** It is a truncation of the
recurrence rule rather than a subtraction, and a wrong UNTIL silently eats the occurrence the
user was standing on. `split-plan.ts` exists to prove a truncation is lossless before it is
written and the delete path has no equivalent; shipping the option without one would make the
only irreversible action the least verified. Two honest choices beat three where the third is
unchecked.

**Contacts and groups exist (0015/0016, ADR 0004).** `contacts`, `contact_groups` and
`contact_group_members` are the people `visibility_rules.audience_ref` has pointed at since
0001. **They carry no name, email or label column** — those are Cloaked under the new
`contact` and `contact_group` subject types, because `attendees` is already encrypted and
storing the same people in the clear one table over would make that pointless. The cost is
that the server cannot answer "is this email a contact of yours?", which booking will
eventually need; ADR 0004 lists the options and rules out "add a plaintext column".

**View As now reads real rules.** 0017 adds `upsert_contact`, `delete_contact`,
`set_visibility_rule` and `delete_visibility_rule`; `server/visibility.ts` loads contacts,
groups and stored rules; `audience.ts` takes them as an argument. `DEMO_AUDIENCES`,
`WORKSPACE_RULES` and the `'ws-demo'` literal are gone from production code — they now live in
`dev-fixture.ts` behind the dev gate, because the e2e privacy suite genuinely needs a
restricted audience to assert against and the fixture is the honest place for demo data.

Two consequences of ADR 0004 show up here rather than being avoided:
- **The server cannot label the audience picker.** Contact names are ciphertext, so
  `ViewAsBar` decrypts them via `useCloakedLabels`. Before unlock it shows `Contact 4f2a…`,
  which is what the server actually sees.
- **Rules have no version guard**, breaking the house RPC pattern on purpose. A rule is a row
  you overwrite by choosing a different radio button; last-write-wins IS the semantics, and a
  version column would put "someone else changed this, reload" in front of a double-click.

A partial unique index makes two rules for one audience unrepresentable. Two rows would be
resolved by the engine's tiebreak — deterministic, and still meaning the UI showed one setting
with a shadow of the previous one behind it.

**Still missing for sharing to be real:** nothing can be sent to anyone. `access_envelopes`
is still unused, and `deriveFieldKey` returns a NON-EXTRACTABLE key, so envelope material
cannot be read out of it. That is the next crypto change and it needs an ADR.

**Then, in order:**
0. `docs/brand.md` records the mark; Visual Guide pages 2-8 have still never been supplied.
1. Read `visibility_rules` from the database. `apps/web/src/server/audience.ts` uses
   hardcoded demo rules, so View As currently demonstrates the engine rather than
   controlling anything.
2. Device pairing UI. The crypto and schema are done and tested; there is no flow.
3. Day and month views — currently disabled controls, honestly labelled.

**Deferred by design:** booking, payments, CRM, automations, external calendar sync, teams,
native iOS. **Independent security review is a hard gate before public launch.**

## Deployment, as of 2026-08-11

**Vercel now auto-deploys `main`.** The project had no Git integration at all — every earlier
deploy came from the CLI, from a `master` ref, and the live site sat 14 commits behind. It is
connected now and a push to `main` produces a production deploy.

Three things about that are worth knowing:

- **CI does not gate it.** `ci.yml` has no deploy step and the Hobby plan has no required
  checks, so they race. A red commit reaches production. Branch protection requiring the `CI`
  check is the fix and is not yet turned on.
- **`cloakcal.com` is registered and verified in the Vercel team but attached to NO project**,
  so no certificate was ever issued and it fails its TLS handshake. Its DNS already points at
  Vercel, so attaching it needs no DNS changes — but **decline any prompt to move the
  nameservers to `vercel-dns.com`**, because the zone is on Porkbun and carries the Zoho MX
  and every Resend record `pnpm email:setup` wrote.
- **Everything is behind Vercel Authentication** (`all_except_custom_domains`), so every
  `*.vercel.app` URL bounces a non-team-member to an SSO page. Attaching the apex is what
  actually makes the site public, not a nicety.

The two Supabase variables are typed **Sensitive** on Production and Preview, which is why
`vercel env pull` returns `[SENSITIVE]` for them. Neither is secret. Retyping needs a delete
and re-add.

---

## Things that will waste your time if you do not know them

- **`next` is a root devDependency purely for Vercel's framework detection.** It is never
  executed from there. See `docs/deploy.md`.
- **Visual baselines are per-platform, and until 2026-08-11 the suite had never run
  anywhere.** Every committed baseline was `-win32`; CI is ubuntu and development is darwin,
  so the project skipped on both while the CI step was named "E2E, accessibility and visual".
  The config comment claimed "CI pins one platform, so regressions are still caught" and that
  was never true. Worse, the documented bootstrap — `pnpm test:visual --update-snapshots` —
  **could not work**, because the project ignored itself until the baselines it was meant to
  create already existed. `isBootstrappingSnapshots()` is the escape hatch that closes that
  loop. `-darwin` baselines now exist; run the `Visual baselines (linux)` workflow and commit
  its artifact to make CI check anything.
- **A colour is checked as a SHAPE and as TEXT, and those are different pairs.** This gap has
  now shipped an AA failure twice. White on `--accent` was 4.20:1 on the Save button; white on
  `--status-danger` was **2.99:1 on the Delete button**, which is the one control in the app
  that cannot be undone. Both times `CONTRAST_PAIRS` checked the colour against the page at
  3:1 and nothing checked the label sitting on top of it. `--status-danger-solid` now exists
  for the filled case, as `--accent` already did. **A hover on a dark filled button must
  DARKEN**: `brightness(1.08)` on the danger red took 4.73:1 down to 4.16:1, in exactly the
  state a user is looking at as they commit.
- **axe only sees what is on screen, so a control behind a click is a control nobody tested.**
  The delete confirmation had no e2e coverage at all, which is how the contrast failure above
  survived — `a11y.spec.ts` scans the agenda, and the Delete button only exists after you ask
  for it. `e2e/delete-event.spec.ts` opens it. When adding a control that appears on
  interaction, add the spec that opens it.
- **A new e2e spec runs nowhere until it is named in `playwright.config.ts`.** The device
  projects use an explicit `testMatch` allowlist, so a spec file that is not listed is
  collected by no project and silently never runs. Exactly the orphan problem the visual
  baselines had.
- **These screenshots catch layout, not colour.** `maxDiffPixelRatio` is 0.02, and repointing
  `--brand-teal` at red measured 0.04% of the page and passed; a background change failed all
  three immediately. No whole-page ratio fixes that. Colour is covered by `CONTRAST_PAIRS` in
  `packages/ui/src/tokens.test.ts` instead.
- **Brand assets are generated and COMMITTED, from one SVG.** `apps/web/src/components/
  cloak-mark.ts` is the only place the mark's geometry exists; `pnpm brand:assets` rasterises
  the favicon, `.ico`, apple icon, PWA tiles and social card from it. Nothing in CI or on
  Vercel runs it. See `docs/brand.md`.
- **Never declare `metadata.icons`.** Next merges the `app/icon.*` and `app/apple-icon.*` file
  conventions only when that key is undefined — the merge is guarded by
  `if (!resolvedMetadata.icons)`. Setting it anywhere silently deletes every tag those files
  would have emitted. `favicon.ico` is special-cased and survives, so the breakage looks
  partial and random rather than total.
- **A generated metadata route has no file extension, and `middleware.ts` excludes assets BY
  extension.** `app/opengraph-image.tsx` serves at `/opengraph-image`, which the matcher
  catches, so an unauthenticated request gets a 307 to `/sign-in` — and crawlers and
  link-unfurl bots are never authenticated. The social card would be blank for exactly the
  audience it exists for. **Nothing here would catch it**: dev and every Playwright project
  run with `NEXT_PUBLIC_CLOAKCAL_DEV_UNLOCK=1`, which returns early before any redirect. That
  is why every icon is a static file with a real extension, and why
  `middleware-paths.server.test.ts` pins each path.
- **The `/account` prerender trap runs in OPPOSITE directions on CI and Vercel.** CI has no
  Supabase variables, so a server page missing `force-dynamic` throws during prerender and the
  build dies loudly. Vercel *has* them, so the same page prerenders silently with an empty
  session baked into static HTML. **Vercel is the permissive one; CI is the gate.** A green
  Vercel build is not evidence that a page is dynamic.
- **`.vercelignore` uses gitignore semantics, so a bare `*.png` matches at every depth.** It
  did, and it would have stripped every icon out of a CLI deploy the moment they existed. It
  now names the two brand boards outright.
- **The font class goes on `<html>`, not `<body>`.** `globals.css` styles `html, body
  { font-family: var(--font-sans) }` and `--font-sans` is declared on `:root`, so putting
  `inter.variable` on `<body>` leaves `<html>` unable to resolve it and everything falls back
  to the literal family name `'Inter'` — which names nothing once Next hashes it. The failure
  looks exactly like a font that did not download. Inter was declared in the tokens from M0
  and **never actually loaded** until 2026-08-11.
- **`next build` has no `--webpack` flag in 15.5**, whatever `next.config.ts` used to claim.
  Webpack is the default and Turbopack is opt-in, so the real rule is negative: do not add
  `--turbopack`, because the `webpack()` hook is the only thing resolving workspace `./x.js`
  specifiers to the `.ts` on disk. This becomes load-bearing at the Next 16 upgrade.
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
- **A page that reads the session needs `export const dynamic = 'force-dynamic'`, and your
  machine will not tell you.** `supabaseServer()` reaches `cookies()`, which opts a route out
  of static generation — so on any machine with `apps/web/.env.local` the page is dynamic and
  the build passes. CI has no Supabase variables, so `supabaseServer()` throws its
  "not configured" error during PRERENDER instead and the whole build dies on a page that
  should never have been prerendered. `/account` shipped this way and broke CI twice. `/` is
  immune only because it takes `searchParams`, which forces it dynamic for unrelated reasons.
  Reproduce a CI build before pushing a new server page:

  ```bash
  mv apps/web/.env.local /tmp/ && NEXT_PUBLIC_CLOAKCAL_DEV_UNLOCK=1 pnpm build; mv /tmp/.env.local apps/web/
  ```
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

## Recovery

**The phrase can now be re-issued** — `/account` → "Get a new recovery phrase", proved with
either the password or the current phrase. Until 2026-08-12 there was no way to get a new set,
so losing the paper while still signed in left the account ALREADY unrecoverable and looking
completely fine. That is worse than never writing it down, because there is no signal: you
find out on the day it cannot be fixed.

Rotation costs nothing in security. It needs the root key, so the caller has already proved
they can open the account — anyone who can rotate could read every event anyway. It takes a
`RootKey` rather than working from the session because a resumed session holds a
NON-EXTRACTABLE key and wrapping needs raw bytes; re-authenticating before minting a
permanent way back in is the right shape regardless.

**The old phrase stops working immediately**, which is the point when the reason for rotating
is that somebody saw the words. `packages/crypto/src/rewrap.test.ts` pins that, and pins that
the wrap's `kind` is authenticated — so a rotated recovery wrap cannot be relabelled into the
password slot by anyone who can write to the table.

**Still only one recovery route.** Spec §Recovery names three — recovery key, trusted-device,
optional secure setup — and only the first exists. Device pairing is the next milestone and
the real fix: the crypto (`packages/crypto/src/device.ts`, ECDH P-256) and the schema
(`root_key_wraps.kind = 'device'`) are done and tested, and there is no UI. With it, a
forgotten password becomes "approve on your phone" and the phrase goes back to being the
last resort rather than the only one.

## Email, and the two things that surprised us

**Delivery works.** Confirmed 2026-08-12: a real password reset landed in a real inbox, from
Resend via Supabase SMTP. That had been unverified since `pnpm email:setup` ran.

**Signing up with an address that already has an account sends NOTHING, and returns success.**
Supabase does that on purpose — a form that said "that address is taken" is an account
enumeration oracle, and for this product "does this person use a privacy calendar" is often
more sensitive than any event it holds. The confirmation screen used to claim "We sent a
confirmation link to X", which was simply false in that case and left the user waiting.
It now covers both cases without resolving which, and offers sign-in AND reset either way.
`signup-enumeration.client.test.ts` forbids branching on `data.user.identities`, which is the
documented tell and the tempting "fix".

**An emailed link needs `/auth/callback`, and `/` is not a substitute.** Confirming an email
silently did nothing for a while: `signUp` passed no `emailRedirectTo`, so the link used
Supabase's Site URL and landed on `/` — which is not public, so middleware redirected to
`/sign-in` before any JavaScript ran. GoTrue had already spent the single-use token by then,
so the link could not be retried and the account stayed unconfirmed. Third appearance of the
same shape: a route that must run for someone with NO session, guarded by the thing that
checks for a session. `/auth/callback` is a Route Handler (it can write cookies, unlike a
Server Component), it is in PUBLIC_PATHS, and `middleware-paths.server.test.ts` pins it.

**Never forward Supabase's auth error text to a user.** Its PKCE verifier failure reads "PKCE
code verifier not found in storage… For SSR frameworks (Next.js, SvelteKit, etc.), use
@supabase/ssr on both the server and client" — advice for whoever built the app, shown to
someone who clicked a link in their email. The callback maps failures to slugs
(`link_dead`, `wrong_browser`) and the sign-in form owns the copy, same rule as the RPC hints.

**The recovery link is PKCE, so it comes back as `?code=`, not a URL fragment.**
`@supabase/ssr`'s `createBrowserClient` hardcodes `flowType: 'pkce'`. The consequence is real:
the exchange needs a `code_verifier` stored in the browser that ASKED, so requesting on a
laptop and opening on a phone cannot work. It used to fail silently — no session, so
`/recover` fell back to the "enter your email" form and the user requested another link that
would fail identically, forever. It now says which of the two things went wrong.

**Templates live in `tools/email-templates.ts`** and are installed by `pnpm email:setup`.
**No remote images, deliberately** — an `<img>` in an email is a tracking pixel, and shipping
one from a privacy product is indefensible even if nobody reads the logs. The wordmark is
text, so it always renders and cannot be blocked. Both templates warn about the two things
above: recovery says you need the 24 words and must open it in the same browser.

## Working style

Match the surrounding code: this repo comments the *why*, especially where a decision looks
odd or diverges from a standard. If you discover a real defect while working, fix it and say
so plainly rather than working around it. If a test is inconvenient, that is usually the
test doing its job — weakening a guarantee to make a test pass is how guarantees stop being
real.
