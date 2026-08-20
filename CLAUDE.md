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
packages/domain/         Recurrence, DST, edit scopes, RRULE/UNTIL conversion, .ics. No I/O.
packages/db/             Migrations + CRUD service, tested against PGlite (no Docker)
tools/                   email-setup (Resend/Porkbun/Supabase), fixture generator,
                         render-brand-assets (icons; output committed)
```

## Commands

```bash
pnpm dev                 # localhost:3000, needs apps/web/.env.local
pnpm build               # production build to .next-prod. RUN THIS BEFORE pnpm test.
pnpm test                # 1350 unit tests
pnpm test:e2e            # 531 Playwright tests, runs its own dev server
pnpm typecheck           # covers .ts AND .tsx
pnpm email:setup         # Resend + DNS + Supabase SMTP, idempotent
pnpm billing:setup       # Stripe product, prices, portal config, webhook. Needs sk_test_
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

**Sign-ups are CLOSED, and the flag is fail-closed.** `/sign-up` renders a "Not open yet"
notice unless `NEXT_PUBLIC_CLOAKCAL_SIGNUPS_OPEN=1`; unset means closed, because forgetting
it in production would silently let strangers into a product whose independent security
review has not happened yet, while forgetting it locally only blocks a sign-up you meant to
do and says so on screen. It is `NEXT_PUBLIC_` and therefore inlined at build time, so
opening sign-ups is a redeploy. **It is the door, not the wall**: the browser talks to
Supabase directly, so Supabase Auth's own "Allow new users to sign up" is the actual
enforcement and the two should always move together.

**Testing auth or recovery against the live project needs a throwaway account, and email
confirmation is ON, so signing up is not enough on its own.** Start the dev server with
`NEXT_PUBLIC_CLOAKCAL_SIGNUPS_OPEN=1` (otherwise the form is not there), sign up through
the UI with any `@cloakcal.test` address, then confirm it by hand:

```sql
update auth.users set email_confirmed_at = now() where email = '<the address>';
```

Sign in to run the key ceremony, and keep the 24 words the screen shows — recovery cannot be
tested without them.

**Cancel any Stripe test subscription BEFORE deleting the account.** The cascade on
`subscriptions.workspace_id` destroys the local record while the processor keeps the
subscription alive and keeps billing it — 0024's header flags this as an operational
requirement no database constraint can enforce, and the first place it bites is your own
test account:

```bash
stripe subscriptions cancel sub_...      # or the test dashboard
```

Then delete the account with
`delete from auth.users where email like '%@cloakcal.test'`; the cascade takes its events,
wraps and workspace with it. **Do not leave one lying around and do not commit its password.**
A known credential on the production project is worth less than this recipe.

---

## Current state, honestly

**Works:** sign up, sign in, first-run key ceremony with a 24-word recovery phrase, unlock,
agenda and week views, week navigation, View As, and the full create / edit / delete loop on
an event. Plus account recovery: `/recover` takes the phrase and a new password, `/settings`
changes a password deliberately (`/account` now redirects there), and both re-wrap the root
key rather than re-encrypting anything. Verified in a browser, not just in tests.

**The 2026-08-12 UI pass shipped the board's shell and a full settings page.** In one day,
eight phases, each merged green: sharpened radii and one shared `ui/Button` (four variants,
the two contrast lessons stated once); a motion system that finally spends `--duration-cloak`
on the uncloak wipe when a sealed value becomes readable, plus a staggered agenda entrance
and a `startViewTransition` view switch whose fallback branch IS the old behaviour; the
privacy level on every agenda row and week block (`decisionToLevel` in packages/policy —
the engine is the only interpreter), where the chip shows the WIDEST disclosure any
non-owner audience gets and, for the owner, is also the door to the per-event Event
Visibility sheet; the desktop sidebar (New Event, mini month of week-links, View As,
calendars, Settings), the mobile week strip, and the five-item nav with the Cloak tile in
the centre opening a privacy-centre sheet; a fail-closed fallback layer (`error.tsx` that
refuses rather than soften, `global-error` with zero imports, a text-free skeleton, 404
that cannot distinguish "missing" from "not yours", an offline banner); and `/settings` —
appearance, time & region, calendars (recolour live while locked, rename not — the privacy
model made visible), people, visibility defaults, security, honest coming-soon rows.
*(That last list is the ORIGINAL seven-card shape, and every later shape is gone too. There
is no accordion: /settings is four doors and every control has a page — see the 2026-08-18
pass below.)*

**Migrations 0001-0031 are ALL applied to production**, verified 2026-08-19 by
`supabase migration list` against the live project: 31 remote versions, matching the 31 files
in `packages/db/migrations/`.

**0029, 0030 AND 0031 were applied together on 2026-08-19, and 0030 had been outstanding since
it was written.** This file said "0001-0028 are ALL applied" and separately flagged 0031; the
two in between were described as if they existed and never as applied or unapplied, so the
security fix in 0030 sat unapplied in production for days while the prose read as if the hole
were closed. **The status of a security migration must never be inferable only from silence** -
and the check is thirty seconds: `supabase link --project-ref bnjbgjzbddypqtoolunz` then
`supabase migration list`, which prints local against remote side by side.

**Superseded, kept for the dates it records.** Migrations 0001-0028 were verified 2026-08-16 against the live
schema rather than assumed: `workspaces.holiday_region` exists, `availability_windows` exists
with RLS enabled, `set_workspace_prefs` takes `p_holiday_region`, `set_availability` exists,
and the security advisor returns zero lints. Anon sweep clean.

**0029 AND 0030 HAD NO RECORDED PRODUCTION STATUS FOR DAYS, AND BOTH TURNED OUT TO BE UNAPPLIED** (fixed 2026-08-19; see the top of this section). The shape is the lesson: This file
says 0001-0028 are applied and separately flags 0031 as not applied; the two in between are
described as if they exist and never as applied or unapplied. 0030 is the fix for a real hole
this file writes up at length: a signed-in user could `DELETE /rest/v1/workspaces?id=eq.<mine>`
and the cascade took the billing row with it. **The status of a security migration must never
be inferable only from silence.** Neither can be settled by the anon PostgREST probe, because
both are about what `authenticated` may do and anon is refused either way; it needs the
throwaway-account recipe (attempt the workspace delete and expect a refusal) or
`supabase migration list` through the CLI. Until somebody runs one of those, assume 0030 is NOT
applied and that production still carries the hole.

**0028 went up BEFORE its code was committed, which is backwards and worth not repeating.**
For a few hours production held the `billing_writer` role, the provider columns and
`billing_events` with nothing in git explaining them. The usual drift in this project is code
ahead of schema, which the 42703 fallbacks handle; schema ahead of code has no such safety
net and is simply confusing. Commit first, then push, then apply.

**How to verify a migration landed when MCP is denied** — and it is denied entirely, read-only
calls included. PostgREST answers the question with the public anon key: a missing column
returns `42703`, a missing table returns `PGRST205`, and a table that exists but denies `anon`
returns `42501`. That last one is the useful signal, because it proves existence AND the
grant posture in one request. Always probe a column you know is absent in the same pass —
without that control, `42501` at the table level can hide the fact that you never actually
reached the column you were asking about.

**How to apply one, because this took three sessions to work out.** The MCP `apply_migration`
and `execute_sql` tools are both denied by the permission classifier and always will be. The
route that works is the Supabase CLI, which needs `"Bash(supabase:*)"` in Keith's
`~/.claude/settings.json` (already there). Two traps:

- **The project ref is `bnjbgjzbddypqtoolunz`.** An earlier session used
  `rkzflvlpxvkbwmsrqpqm`, which is not this project. `supabase projects list` is the source
  of truth.
- **`db push` refuses unless the local migrations directory is a SUPERSET of the remote
  history table**, and this repo keeps migrations in `packages/db/migrations/` with `NNNN_`
  names rather than the CLI's timestamp convention. Do NOT run `supabase migration repair`,
  which the error message suggests — it would mark 25 applied migrations as reverted. Build a
  throwaway project in the scratchpad instead: `supabase init`, one empty placeholder file per
  remote version (the error lists them), then the real migration named with a LATER timestamp.
  `--dry-run` first; it should name only the new files.

**Code must still tolerate an unapplied migration**, and that stays true regardless: code
deploys on push, migrations are manual, so the two always disagree for a window.
`loadWorkspacePrefs` retries without the unknown column on a 42703 and `loadAvailability`
returns an empty week from its catch. That resilience is a lesson worth keeping — the prefs
read used to destructure `data` and DROP the PostgREST error, so an unknown column arrived as
"this user has no workspace" and would have silently reset every account's timezone, week
start and default view.

**Keep this line current.** It
said "0018–0020" for two migrations longer than it was true, and the cost was real: the
default-view feature read as unbuilt when it was shipped and deployed, so it got looked for
in the code rather than in the UI where it was merely hidden. Two real defects
found and fixed on the way: contact-name ciphertext was never INGESTED into the CloakStore
(View As showed `Contact 4f2a…` forever on real accounts — invisible to e2e because fixture
audiences carry no nameField; `CloakProvider` now takes `extraFields`), and real accounts
passed an EMPTY `groupsByContact` to the engine, so group rules never applied outside the
fixture. **The ingest fix had a second half, found 2026-08-14 by a live-account pass:** the
provider's homegrown hex parser assumed BARE hex, but `visibility.ts` ships PostgREST's
`\x…` spelling raw (events.ts strips it; visibility.ts never did), so `parseInt('\x')` was
NaN, every byte misaligned, and contact names STILL never decrypted on real accounts — with
no error anywhere, because a failed GCM tag is just a label that never opens. The provider
now parses with the shared `fromPgBytea`, which handles both spellings and throws loudly on
garbage. The lesson is the same one pg-bytes.ts already documented: bytea format mismatches
are QUIET, and only a live pass with a real sealed value can see them — which is exactly why
the throwaway-account recipe exists and why fixture-only green is not evidence for anything
touching ciphertext transport.

**The brand is real now.** There is an actual mark — a calendar tile with a cloak over its
lower-right corner, where the dates under the cloak are ABSENT rather than dimmed — replacing
the 32px gradient square that stood in for a logo, and the eleven lines of markup that were
copy-pasted into four components. Favicon, `.ico`, apple icon, PWA tiles and a social card all
generate from that one SVG. Inter is loaded for the first time. `docs/brand.md` records which
parts of the mark the references specify and which are extrapolated.

**Ported to RPCs so far:** `create_cloaked_event` (0007), `trash_cloaked_event` (0008),
`update_cloaked_event` (0011), `split_cloaked_event` (0013), `cancel_occurrence` (0014),
`restore_cloaked_event` / `uncancel_occurrence` / `purge_cloaked_event` (0031). All
SECURITY INVOKER, so RLS decides what they can touch; all audited without naming anything.
All version-guarded EXCEPT `uncancel_occurrence`, which is deliberate and is explained at
length above the function: a trashed EVENT is frozen, so `version - 1` recovers the delete
version from a plain read and restore can check it, but a SERIES is not — cancel two
occurrences and the first one's delete version is unrecoverable from anything that only sees
the row now, which is exactly the position the Trash page is in. A guard only the undo strip
could satisfy would turn the durable route into a permanent false conflict, and there is
nothing for it to protect: removing one exception row cannot clobber an edit. Same call 0017
makes for visibility rules. Follow that shape for the next one — one RPC per user action, an expected
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

**Crypto-agility audit, 2026-08-14 (cloak-boundary's first pass).** Verified, not assumed:
the ciphertext format is ALREADY versioned and fail-closed, so no `format_version` column
is needed and adding one would be a second copy of versioning that can drift. The version
lives in the `cloak_alg` enum value itself (`aes-256-gcm-v1`); 0004 removed the only
constraint that hardcoded v1 (nonces are now simply required for every alg), RPCs cast
`(field ->> 'alg')::public.cloak_alg` and accept any enum value, and
`packages/crypto/src/cloak.ts` throws on an alg it does not implement. A future padded /
AAD-bound format is one `alter type public.cloak_alg add value 'aes-256-gcm-v2'` plus a
client that writes v2 and still reads v1 — that work is next phase, behind an ADR, along
with: padding sealed fields to length buckets (ciphertext length currently leaks content
length), binding the plaintext times into the AES-GCM AAD so the server can see times but
not forge them (Proton's model), and the per-calendar key layer for sharing. The KDF is
Argon2id at m=65536, t=3, p=1 — 3.4x the OWASP memory floor, not at it. The floor
(m=19456, t=2, p=1) is `KDF_FLOOR` in `packages/crypto/src/kdf.ts`, the value
`assertKdfParams` refuses to go BELOW; `CURRENT_KDF_PARAMS` beside it is what is actually
used. This note said "at exactly the floor" for months, which understates a security
parameter and is the kind of wrong that invites someone to "correct" the code downward to
match the docs. `assertKdfParams` refuses any server-supplied weakening, and being above
the floor is the right posture here rather than a nicety: the wrapped root key is servable
to an offline attacker, so the cost of a guess is the only thing making one expensive.

**The CSP gap this note recorded for months is CLOSED (2026-08-16).** A per-response nonce,
built in `apps/web/src/lib/csp.ts` and applied in middleware. Four things about it matter:

- **`buildCsp` is a pure function so the PRODUCTION policy can be asserted without a
  server.** Playwright runs `next dev`, and dev is deliberately looser — `'unsafe-eval'` for
  React Refresh, `ws:` for HMR. The browser suite therefore only ever sees the weak policy;
  `security-headers.server.test.ts` reads the strict one directly.
- **It is applied ABOVE middleware's dev-unlock early return, and a test pins that order.**
  Every Playwright project sets that flag, so a policy applied after it would be absent in
  dev, absent under test, and present only in production. Same shape as `/opengraph-image`.
- **`connect-src` names the Supabase origin, and NOTHING HERE CAN VERIFY THAT.** The fixture
  never calls Supabase, so a wrong origin passes every test and breaks every real account on
  its first query, as an opaque network error with no mention of CSP outside the console.
  Only the throwaway-account recipe sees it. Re-check it by hand after any change to that
  directive.
- **`style-src` keeps `'unsafe-inline'`**, stated rather than buried: Next inlines critical
  CSS and next/font emits an inline `<style>`, neither nonce-able. Script is where the
  compromise lives and `script-src` has neither unsafe. Do not "fix" a CSP-broken page by
  moving that pattern into `script-src`.

**Every app route is DYNAMIC now, as a direct consequence** — a per-request nonce cannot
exist in a page built once, so the root layout reading `headers()` opts the whole app out.
`/sign-in`, `/sign-up` and `/recover` were the last prerendered ones. **This displaced a
privacy gate, and the way it displaced it is the lesson**: `build-output.leak.test.ts`
scanned prerendered HTML and RSC payloads off disk, and when the input vanished the RSC
assertion failed loudly while the HTML one kept PASSING — Next's framework `500.html` still
matched its filter, so it was green while scanning a page that could never hold user
content. Both moved to `e2e/leak.spec.ts`, which fetches each route's HTML and its Flight
payload (`RSC: 1`) from a live server and guards the bodies are non-empty first. What
remains on disk asserts that NO app route prerenders, which is what fails if one is ever
made static again without restoring a scan.

**Day and Month are real views now** (second pass, same day). `?view=agenda|week|day|month`
+ `?date=YYYY-MM-DD` (`?week=` accepted as a legacy alias); agenda/week stay ONE fetch with
an instant client toggle, day/month are server navigations; steppers move the anchor by the
view's unit with month pinned to day 1. `monthGridRange` fetches the VISIBLE 42-day grid so
leading cells cannot render empty while events exist on them. Day is `WeekGrid dayCount={1}`;
month is `month-grid.tsx`, whose cells are links into the day view and which deliberately
carries NO privacy chip at 84-cell density (commented in the file). `range.ts` finally has
unit tests (DST-boundary grids). The chrome split per device: the five-slot bar is
phone-only, desktop gets a segmented view control + compact Cloak button in a clustered
header. `/` is PUBLIC and branches on the session: landing page signed out (its copy is
bound by rule 1 — the honesty block states what the server can and cannot read), calendar
signed in. *(Settings was `<details>` cards with `#section` deep links when this was written.
It is four doors and four routes now; the old anchors are forwarded on the client. See the
2026-08-18 pass.)*

**The 2026-08-13 pass: navigation, calendars and the keyboard.** Five parts, each merged
green. The sidebar overhaul (mini-month days now OPEN that day rather than preserving the
view — a click inside the visible week used to be a no-op and read as broken; the account
cluster became divided rows). The landing rebuilt dark and demo-first, its hero a live
event card that reseals as the audience changes, where the TIME never moves: rule 1 drawn
before the honesty block states it. An em-dash sweep across every user-facing string,
pinned by a DOM assertion rather than by review. Week and day blocks became doors (edit and
visibility from the grid, not just the agenda). And calendar creation: migration 0021,
`create_calendar`, the board's "+ Add calendar" row, plus a Calendar picker on New event.

**Keyboard navigation exists** (`calendar-hotkeys.tsx`): `t` today, `←`/`→` or `k`/`j`
step, `1`-`4` views, `n` new event, `?` a help dialog. Single keys, no modifiers, because
that is what Google Calendar and Fastmail trained everyone on and modifier chords collide
with screen-reader bindings. The guard order IS the contract: handled event, any modifier,
IME composition, focus inside text entry, or ANY open `dialog` all mean the key is not
ours. That satisfies WCAG 2.1.4's text-entry condition; **a Settings toggle to disable
them entirely is the recorded remaining gap**, not a claimed conformance. Controls that
mirror a binding carry `aria-keyshortcuts`.

**`lib/calendar-links.ts` is now the ONE nav-query builder.** Steppers (server), the view
switch and Today (client), and the hotkeys all call it. Today-from-Week landing on the
agenda was two builders disagreeing about when `view` is carried; one module plus
`calendar-links.client.test.ts` is how that class of bug stays fixed.

**The 2026-08-15 pass: one audience picker, a findable default view, and Settings.**
Three things, all of them about a feature that existed and could not be found or used.

- **The Cloak sheet and View As overlapped**, and not subtly: the sheet rendered the
  sidebar's `ViewAsBar` component itself, so on a phone with the sheet open there were two
  live "Viewing as" selects bound to the same state, plus two copies of the audience-name
  fallback. The split is now by what each surface CAN do — the sidebar bar owns the MODE
  (the accent border and hidden-events count, which a dismissed dialog cannot show), the
  sheet owns the MAP and each of its rows is the door into previewing as that person, plus
  "Back to my own view" since owner is filtered out of the rows. `audienceHref` and
  `useAudienceNames` are the one URL builder and the one label function.
- **`default_view` (0022) was invisible three ways over**: labelled "Opens on", third
  inside a collapsed card called Time & region, and in the fixture the control was DISABLED
  and the calendar skipped `loadWorkspacePrefs()` entirely. It is "Default view" under
  Appearance now, plus a "Make Month my default view" control in the calendar sidebar,
  owner-only. Both write through `lib/save-prefs.ts` rather than each carrying its own copy
  of "demo writes a cookie, an account writes the RPC".
- **The demo has real preferences**, in a COOKIE (`lib/demo-prefs.ts`), because the view is
  resolved server-side before anything renders and a browser-only store could not reach that
  decision without a flash of the wrong view. This retired the `?? fixtureMode` special case
  on the keyboard opt-in — one preference had an escape hatch that no other preference got.
- **Settings was restructured, not just repainted.** Seven cards to five *(and then to no
  cards at all — the 2026-08-18 pass below made every one of them a route)*: two of the seven
  held no settings at all, and Security was an entire auth page pasted into a `<details>`,
  bringing its own lockup and its own `<h1>` so the page rendered two. It is
  `/settings/security` now, which is also where the device list moved from the bottom of the
  roadmap card. Five row shapes became one, the selects are drawn rather than left to the OS,
  and the stylesheet finally speaks the file room that People has spoken since the Dial pass.

**One live bug fixed on the way, caused by 0022 and invisible until now.** All three nav
builders in `lib/calendar-links.ts` omitted `view` when the target was agenda, because the
server's fallback WAS agenda. Once a workspace could store a different default, an agenda
link with no view param resolved to that default instead: with a month default, clicking
Agenda left you on Month, and so did Today and the `t` hotkey. Agenda and week hid it
between them, since that pair is a client toggle that never consults the URL. Every builder
names its view now, unconditionally.

**The 2026-08-15 plan pass: a tier you can see, and a price nobody can pay yet.**
`/settings/plan` and a badge in the sidebar account cluster, plus migration 0024 behind
them. Pricing is decided and recorded in ADR 0007: **Free is everything CloakCal does
today**, because "basic privacy is never paywalled" makes the whole shipped product free by
the spec's own rule; **Pro is $8 a month or $72 a year** (three months free) and is named,
priced and explicitly NOT purchasable. Pro's `includes` list is EMPTY on purpose — listing
shipped features under it would be claiming free accounts do not have them — and its four
planned items (booking, external sync, shared calendars, automations) are each unbuilt and
labelled so. Export is on FREE permanently: charging to leave is not something a privacy
product gets to do. **No published limits on either tier**, because nothing counts anything
and there is nowhere to enforce a count.

**The plan is the first fact in this product the user may READ and may not WRITE**, and that
asymmetry is why it is not a column on `workspaces`. `workspaces_update` (0002) is
`for update to authenticated using (owner_id = auth.uid())`, and a policy is ROW-level: it
cannot name a column, so it authorises every column of every row it authorises. And the
column-level revoke that looks like the fix is a **silent no-op** — verified on PGlite while
writing 0024, not reasoned about: with the table-level UPDATE grant standing,
`revoke update (plan) ... from authenticated` leaves `has_column_privilege` true and warns
about nothing. Same family as the 0009 grant trap. So `subscriptions` is its own table with
ONE `for select` policy, `revoke insert, update, delete` on top of it, and **no row for
anybody: absence means Free**, which needs no bootstrap insert and therefore no insert policy
at all. Both gates were proved by hand — removing the revoke reds three tests, widening the
policy to `for all` reds two others.

**How billing will write without a service-role key is in ADR 0007 and is the reason for the
separate table.** A webhook has no session, rule 4 bans the service key and
`security-posture.test.ts` bans SECURITY DEFINER, so it connects as its own `billing_writer`
role with a policy on that one table. On a table holding one fact, that role's blast radius
is that fact; there is no spelling of the same grant against `workspaces` that does not also
hand it `lifecycle` and `route_token` on every row.

**A third defect, and it is the one worth reading: TRUNCATE was granted to `anon` on every
table.** Supabase's default ACL for a new public table is `arwdDxtm` for both `anon` and
`authenticated` — which includes TRUNCATE, and **RLS does not filter TRUNCATE**. There is no
per-row decision for a policy to make, so `force row level security` plus a `using (false)`
policy does not stop it; only the absent privilege does. All sixteen tables had it, `events`
and `cloaked_fields` included. Latent rather than open — PostgREST exposes no TRUNCATE verb
and `anon` is NOLOGIN, so nothing could reach it — but the blast radius was the whole database
for every user. `0025_revoke_truncate.sql` takes TRUNCATE, REFERENCES, TRIGGER and MAINTAIN
away from both roles and leaves the four DML verbs RLS actually mediates.

It surfaced because 0024 wrote its revoke as an ALLOWLIST (`revoke all` then `grant select`)
rather than naming three DML verbs, which is the lesson to carry: **subtracting the verbs you
thought of cannot survive a verb you have not heard of.** MAINTAIN is exactly that verb — new
in PostgreSQL 17, and it arrived pre-granted. **The harness could not have caught it either**:
its shim granted four of the eight privileges under a comment claiming it mirrored Supabase,
so the harness was a STRICTER fiction than production on precisely the axis a hardening
migration is tested for. It grants all eight now. Same shape as the missing `anon` role that
hid the 0009 hole, and the fix is the same: the sweep in `security-posture.test.ts` is the
backstop, not the migration, because `alter default privileges` cannot reach Supabase's
`supabase_admin` defaults.

**The light theme had never been scanned, and it was carrying four separate AA failures.**
Every axe run in this repo scanned dark, and light is the theme the brand references actually
draw the calendar in. One pass with a light-theme sweep found: `--text-tertiary` at
rgba(11,13,20,0.48) measuring 3.31 to 3.41 across the three surfaces, which is the ink on the
mini month's dates, the sidebar headings, every form legend and the security page's hints;
`--status-success` used as a 12px "Free" label at 3.47 (a colour checked as a SHAPE and used
as TEXT, the third time that has bitten here); the settings rail's index dimmed with opacity
to 3.46; and the agenda's delete trigger dimmed the same way to 3.36. Tertiary is 0.60 now
(4.81 worst case, where dark already sat), `--status-success-text` exists for the label case,
and both opacity dims are tokens. `e2e/a11y.spec.ts` now scans SIX pages in the light theme,
which is the guard that stops this recurring.

**Waiting on `getAnimations()` can hang, three ways, and the repo's usual one-liner hits all
three.** `a.finished` RESOLVES WITH THE ANIMATION OBJECT, so `Promise.all(...)` hands
Playwright an array of live host objects to serialise back and it wedges until the test times
out — the existing calls survive only because the array is empty by the time they run, and
ten finished button transitions after a theme toggle is enough to break it. An INFINITE
animation's `finished` never resolves at all (`.pulse` in the loading fallbacks). And a
CANCELLED transition REJECTS, failing the whole `Promise.all`. The light sweep filters
infinite animations, catches rejections, returns `undefined` from an async body, and races a
2s backstop — the settle is still the mechanism, the cap only bounds a promise that provably
can fail to settle.

**Two more defects found on the way, both fixed.** `e2e/settings.spec.ts`'s first test was named
"in the stated order" and only ever asserted each heading was VISIBLE, so a section could be
inserted anywhere or two could swap and the suite stayed green; it reads the DOM order now.
And `.navIndex` in the settings rail was `--numeral-ink` at `opacity: 0.7`, which composites
to 5.86:1 on dark and **3.46:1 on light** at 12px — an AA failure on /settings,
/settings/security and /settings/plan that nothing had ever seen, because until
`e2e/plan.spec.ts` every axe run in this repo scanned the dark theme only. `--numeral-ink-quiet`
is a real token now, pinned on all three grounds in both themes. **Second time this project
has dimmed with opacity over ink that barely passes**; the mini month was the first. There is
now one axe test that scans a non-default theme, and it is what caught this.

**The badge shows for Free as well as Pro**, because absent would be ambiguous — free, or
unreadable, or not loaded — and a badge that appears only when you pay is a status symbol,
which inverts "paying buys power, not standing". It does NOT reuse the privacy inks: those
four colours are learned meaning, and a billing tier in the "Limited details" indigo would put
something indistinguishable from a privacy chip in the sidebar. Its washes are OPAQUE where
the privacy chip's are alpha, because it renders on three surfaces and under a hover nothing
screenshots. **It never renders in the fixture** (the account cluster needs a real session),
so `/settings/plan` renders the same component under the demo — that is what puts it in front
of axe at all — and the sidebar composition is pinned by `plan-badge.server.test.ts` instead.
The one thing no test here can see is a real email beside a real badge in a 300px sidebar;
that needs the throwaway-account recipe.

**The 2026-08-15 controls pass: filled fields, one button system, a hero that reseals, and
availability.** Four things, and three of them found bugs nothing else could see.

- **Every rectangle on a form was the same rectangle.** Inputs, buttons, cards and chips all
  sat at `--radius-md` with a `--border-default` outline. `--radius-control` (6px) is what a
  thing you type in or press wears now, and fields are FILLED (`--field-bg`, `--field-border`).
  Their own tokens, not a `--surface-*` reuse, because in LIGHT `--surface-raised` and
  `--surface-overlay` are both `#ffffff` — the old field was white on white plus a 1.6:1
  hairline. **The border stays and that is measured**: a borderless filled field only meets
  WCAG 1.4.11 when the fill clears 3:1 against the page, and on this palette that lands near
  `#5a5d65`, a slab that reads as disabled. The fill says "type here", the border identifies.
- **`auth.module.css`'s `.submit`/`.secondary` are gone**, 16 call sites moved to `ui/Button`.
  That was a second button system with its own radius, a flat accent and `cursor: progress` on
  every disabled state. `auth-buttons.server.test.ts` is the guard, because a comment did not
  stop it the first time.
- **NOTHING HAD EVER SCANNED THE AUTH PAGES.** Every axe run covered the calendar, settings,
  security, people and the landing, and never `/sign-in`, `/sign-up` or `/recover` — the first
  pages a stranger sees and the ones asking for a password. All three are in the light sweep.
- **`--ease-out` DOES NOT EXIST** and was used in two files. An undefined custom property is
  invalid at computed-value time, which **voids the whole declaration** rather than falling
  back — so the landing's sweep and reseal were not mistimed, they were absent, and the
  sweep's gradient sat frozen mid-grid looking like a rendering artefact. Caught by opening a
  screenshot, not by a test. `design-tokens.server.test.ts` now fails on any bare `var()`
  naming a property nothing declares.
- **The landing hero is a WEEK that reseals**, not a card with tabs. The pitch is not "a field
  can be hidden"; it is that the same week reads differently to four people at once. The grid
  never moves — every block's top and height come from `--from`/`--span`, properties of the
  EVENT — which is why the reseal is a `clip-path` wipe and not a scale. Hidden is ABSENT.
- **Availability (0027)** stores weekly windows in wall-clock minutes and shades the hours
  outside them on the week and day grids. The overlap rule is **data hygiene, not a security
  boundary**: the RPC is SECURITY INVOKER, so the caller necessarily holds INSERT and can
  write overlapping rows directly — `server/availability.ts` MERGES rather than trusting.

**The 2026-08-18 settings pass: four doors, and a price nobody could pay.**
`/settings` was organised like an internal control panel — a four-figure readout band at
display size, a seven-item numbered rail, a seven-card accordion and a roadmap footer, inside
a 64rem column that stops growing at 1024px. It is a HUB now: four doors, each stating one
true fact, and nothing else. Every control moved to a page.

- **`/settings/privacy` and `/settings/calendar` are new**; security and availability already
  had routes. Privacy is FIRST, because it is the product — the old page opened with a theme
  picker. "People & sharing" is gone as a label: it promised sharing that is not built.
- **The hub is a plain server component with no `CloakProvider` and no client JS** (2.05 kB).
  It renders no calendar name, no contact name and no group label, which is why
  `loadSettingsSummary` is head counts only. Keep it that way; a friendlier summary must not
  re-add the provider or ask the server for a name it structurally cannot read.
- **`SettingsNav` is deleted.** Its three jobs all evaporated with the accordion, and it had
  shipped two defects nothing else could see (the numbered index at 3.46:1 in light; the
  `min-width: 0` on the flex child instead of the grid item, illegible at 390px on four
  pages). `SettingsDoors`/`SettingsSiblings` are static links — nothing to measure.
- **Also deleted: `useOpenOnHash`, `useVisibleSection`, and `selectBand`'s sixty lines of
  watching the document stop moving before it dared scroll.** A hash still works:
  `LEGACY_SETTINGS_HASHES` + `legacy-hash-forward.tsx` map the seven old anchors to routes on
  the client, because **a hash never reaches the server** and someone will try middleware.
- **Export moved from the Calendars card to `/settings/security`, and `legal.ts:170` moved
  with it in the same commit.** That page is "Security & data" now. It also gained the FIRST
  `mailto:` in the product: deletion is by email, the privacy policy said "by emailing us"
  and never gave an address, so the promise was honest and unusable. Still no button, and the
  copy says why.
- **The plan page quotes no price.** `ProBand` drew `$8`/`$72` whenever `billing === null` —
  the price appeared in exactly the state where nobody could pay it, and vanished in the state
  where the billing band draws the same figures as pressable controls. The arithmetic still
  lives in `lib/plans.ts` and is still rendered by `billing-band.tsx`, where the cards are
  buttons. **The Billing door itself renders only when `billingEnabled()`**; the route stays,
  because Stripe's three return URLs point at it.
- **The roadmap footer is gone.** Each gap is stated where it bites instead: calendars cannot
  be deleted yet, beside the calendars list; device pairing, beside Passkeys.
- **A two-up door grid lasted one screenshot.** The door COUNT is not fixed — Billing is
  conditional — so the common case was three doors in four cells, and the hole read as a page
  that failed to load. Full-width rows fill the measure at any count.
- **THE HUB'S FOUR LINES HAVE NEVER RUN AGAINST AN ACCOUNT, and the composition was split out
  so that at least the sentences could be.** The fixture has no session and no workspace row,
  so `loadSettingsSummary` returns null before composing anything and every door reads "Demo":
  not one character of the copy a signed-in user sees was reachable by any test in the repo.
  `lib/settings-summary.ts` is the pure half now and `settings-summary.server.test.ts` covers
  every branch of every door. **What remains unverified is the wire** — whether PostgREST
  returns those counts, under RLS, for a real user. Only the throwaway-account recipe sees it,
  and it is the same shape as the contact-name ingest bug: fixture-only green is not evidence
  for a path the fixture cannot take.
- **`summariseSettings` takes numbers, and that signature IS the no-labels rule.** Everything
  it accepts is a count, plus an IANA timezone and a catalog plan name — both Tier A, both the
  same for anyone on that tier. There is no parameter a calendar name, contact name or group
  label could arrive in, so the obvious future request ("make the Calendar line say WHICH
  calendars") is a compile error rather than a review catch. The other half — that the queries
  stay head counts and never name `cloaked_fields`, `ciphertext` or a wrap column — is a source
  sweep in the same file, proved by injecting both violations and watching it fail.

**The 2026-08-19 finish pass: the cloak moved to the surface it is about, a write leaves a
mark, and delete became reversible in the product rather than only in the schema.**

- **THE COVER IS OPAQUE AND `inert`, AND THAT IS CORRECTNESS RATHER THAN STYLE.** An
  audience switch is a server navigation on a force-dynamic route, so the OLD frame is on
  screen for the whole round trip. The first draft held it at `opacity: 0.5; blur(2px)`,
  which is not redaction: a 2px blur leaves a title legible and does NOTHING to the
  accessibility tree, so the owner's full titles would have stayed readable to a screen
  reader for the entire fetch while the arriving frame said "Previewing as Dana". The plate
  is `--surface-base` at full opacity and `<main>` is marked `inert` on the same tick.
  `inert` ALONE, never plus `aria-hidden` — per spec inert already removes the subtree from
  the accessibility tree and is strictly stronger, and stacking both invites a false
  `aria-hidden-focus` finding from axe.
- **The wipe is `clip-path` ONLY, and must never regain an opacity stop.** The first
  keyframe faded 0.6 → 1 alongside it, which makes the cover a FOG for 420ms — the same
  defect wearing an animation. `e2e/cloak-transition.spec.ts` samples the computed opacity
  mid-wipe; it read 0.607 and now reads 1.
- **Direction is the meaning: narrowing covers, widening retains.** Showing LESS than you
  are entitled to is never a disclosure error, so going back to your own view keeps the
  restricted one until the fuller one arrives — with a status line, because no cover must
  not mean no feedback. `lib/view-transition.ts`'s refusal to bracket a server navigation in
  `startViewTransition` STANDS: this is an outgoing gesture concurrent with the fetch, not a
  cross-fade, so it costs zero added latency instead of freezing the old frame.
- **`useAudienceSwitch` is the one audience door.** Three surfaces used to call
  `router.push(audienceHref(...))` themselves; a fourth that forgot to seal would silently
  reopen the gap.
- **A write leaves a mark, and create and edit are different promises.** Create may navigate
  to what you made and takes focus; EDIT NEVER NAVIGATES — it names where the event went and
  offers a door. Both leave the sheet open with every field intact on failure. The row wears
  a persistent inset accent ring; nothing is timed, and `--z-toast` stays the offline
  banner's. A toast dismisses on a wall clock, which is the mistake `nav-feel.spec.ts`
  already paid for.
- **Undo, plus a Trash page, because a strip dies on reload.** `/settings/security` lists
  trashed events AND cancelled occurrences. It is called **Trash** and never "Recently
  deleted": nothing expires, and a name implying a window that does not exist is the export
  claim's mistake in a different sentence. The retention truth shipped in `lib/legal.ts` in
  the same commit, paired by a `legal-claims.server.test.ts` capability.
- **A cancelled occurrence offers Restore ONLY.** It is a subtraction, not a row: the series
  owns the ciphertext, so there is nothing separate to erase and deleting the exception IS
  the restore. One whose series is itself trashed is not listed twice.
- **Focus is not stolen.** The undo strip is `aria-live="polite"`; focus moves to Undo only
  when the delete was keyboard-initiated (`event.detail === 0`), where the sheet has just
  unmounted and focus would otherwise land on `<body>`.
- **Seeding is `Promise.allSettled` and reports partial success** ("Added 6 of 8"), retrying
  only the specs that failed. It can no longer rest in "Adding…" or claim completion.
- **One inline first-run prompt**, on five conditions (owner, armed by a first successful
  save, a non-empty page, zero contacts, not dismissed), opening the Event Visibility sheet
  so adding a person and choosing what they see happen together. No re-arm path at all.
  **Nothing in the repo can render it** — the fixture ships demo audiences, so the
  zero-contacts condition is false on every Playwright project.

**The 2026-08-20 mobile pass: the phone is its own product, on five surfaces.**
Day, Week, Month, Cloak and Settings, redesigned rather than re-padded. Measured at
390x844, zero insets, fixture, dark:

| | header | first content |
| --- | --- | --- |
| Day | 97 -> **69** | 371 -> **204** |
| Week | 89 -> **69** | 371 -> **253** |
| Agenda | 89 -> **69** | 371 -> **204** |
| Month | 69 | 237 -> **173** |

- **ONE DATE PER SCREEN.** The day view printed the date three times in its first 240px:
  the header, the week strip's ringed number, and "THU 20" at the top of the grid. The
  strip wins because it is also a CONTROL. The column head is dropped by CSS at
  `[data-single]` **below 900px only** -- above that the strip hides itself and the head is
  the day view's only date. `formatRangeCompact` gives the phone a shorter STRING rather
  than a smaller one, and its en dash is unspaced where `formatRange`'s is spaced: 15
  characters instead of 17, which is the difference between one line and two.
- **THE ACCESSIBLE NAME TAKES THE COMPACT STRING TOO.** Printing "August 2026" while
  speaking "Jump to today, Thursday, August 20, 2026" fails WCAG 2.5.3 -- the name does not
  CONTAIN the visible label, so the control is unreachable by voice while looking correct.
- **The View As card is a 44px row on a phone, owner only.** Its picker is the Cloak sheet.
  The first draft also announced "Previewing as {name}", which `PreviewBar` already does 44px
  away -- so the row states the RESTING state and stands down when there is a mode to
  announce. **A bare chip beside "Viewing as Me" inverts its meaning** ("Me sees Limited
  details"); it says "Others see" now.
- **The theme toggle left the phone header**, 56px of a 390px row, with its replacement
  named first: `/settings/calendar` -> Appearance holds a real Theme radiogroup.
- **The FAB is a 48px circle**, reversing `new-event.module.css`'s written "a raised
  rectangle, not a pill" -- that objection was to an elongated capsule and a circle has no
  long axis. `.main`'s bottom padding stops being dead (the nav has owned its own grid row
  since the shell rebuild) and becomes the FAB's clearance, derived from its geometry: an
  e2e assertion checks nothing sits under it at maximum scroll.
- **Week is three columns, paged, with the fourth peeking.** `100cqi`, never `100vw` -- the
  latter hardcodes `.main`'s padding into a child's width. The peek is RESERVED before
  dividing, or the fourth column vanishes and the week looks like it ends on Wednesday.
  Snap is `mandatory` on every third column. Phone hours went 3.5rem -> 4.5rem, which is
  what makes a 20-minute event legible at all.
- **Month is dates and marks, with the words underneath.** 44px cells, up to three dots,
  and the selected day's events listed in full below the grid. **The dots ARE the entries** --
  same elements, phone keeps the spine and drops the title -- so the dot count and the entry
  count cannot drift. **No count and no "+N more"**: `redactPage` has already dropped what
  this audience may not know about, so a count would be truthful, but a number invites "is
  that all of them?", which is the one question this product must never appear to answer.
  Selection is client state and costs no fetch, because `monthGridRange` already fetched all
  42 days.
- **The Cloak sheet opened with a focus ring on its DISMISS control.** `showModal()` focuses
  the first tabbable descendant and Close was first in the DOM. Focus goes to the sheet body
  now. The lede lost "Every person and link that can reach your calendar" -- `lib/plans.ts`
  already bans that phrasing in a feature list and this sheet was the last surface making the
  claim; the public row keeps its label and gains "No link exists yet. This is the rule it
  will follow."
- **Settings is one grouped list**, 365px to the last row instead of 444. The door
  descriptions are gone because every destination already opens with the same sentence in
  its own `PageMasthead`.

**What this pass did NOT do, stated so it is a decision rather than a gap:** the Privacy
door still reads "1 person . 1 default rule" rather than "Default: Full details". The
baseline level is Tier A and would be the better line, but `widestLevel` is a local in
`server/audience.ts` over viewers built from a full `loadWorkspaceVisibility`, and the hub is
deliberately six head counts with no CloakProvider and no client JS. Changing what that line
MEANS is a product decision with an architecture cost, not a copy tweak.

**Then, in order:**
0. `docs/brand.md` records the mark; Visual Guide pages 2-8 have still never been supplied.
1. Booking + per-contact share links — the next dedicated phase, and **NOT gated on the
   share-key crypto ADR**, which this line claimed for months and which was wrong. See ADR
   0008: sharing splits by DISCLOSURE LEVEL, and `decisionToLevel`'s `busy` and `hidden`
   steps emit no ciphertext at all, so there is nothing for a recipient to decrypt. A booking
   page (free/busy only) and a per-contact share link at busy level need no new crypto. The
   envelope work gates `limited` and `full` only, and it is a separate ADR that nothing here
   depends on.
2. Device pairing UI. The crypto and schema are done and tested; there is no flow. Demoted
   by passkeys, which answer the same question without a second device.
3. Month-cell interactions (edit/visibility from a cell) — cells currently drill into day.
4. **Stripe is BUILT, in test mode, behind a fail-closed flag. It has never met a real
   Stripe account.** See ADR 0009. Checkout, the webhook, and cancel / resume / switch on our
   own settings page; `pnpm billing:setup` provisions the Product, both Prices, the portal
   configuration and the webhook endpoint over the API. Everything below is what remains:
   - **A `sk_test_…` key.** The one input nothing here can substitute for.
   - **`billing_writer` has no password.** 0028 created it NOLOGIN deliberately; the
     `alter role` block in `docs/deploy.md` has to be run by hand, and until it is, every
     webhook 500s *after* checkout has already succeeded.
   - **The pooler question is ANSWERED, and not the way the design assumed.** Supabase offers
     this project a DEDICATED pooler at `db.<ref>.supabase.co:6543`, whose username is the
     bare role rather than Supavisor's `billing_writer.<ref>`. `billingConfig()` required the
     suffix and would have rejected the only correct string, silently, as "not configured".
     Both spellings pass now. **But that host has no A record — it is IPv6 only, and Vercel
     functions connect over IPv4, so it works locally and fails in production.** Either find
     the shared Supavisor pooler (IPv4, takes the suffixed username) or buy the IPv4 add-on.
     See docs/deploy.md.
   - **Cancelling upstream before an account delete.** Still unbuilt, because there is still
     no delete flow to hook it to. The legal copy now says deletion is by email, which is
     true; when the flow lands, the upstream cancel is its FIRST step.

   `billing_events` settles the idempotency question ADR 0007 left open: the event id is the
   primary key, so a replay is a constraint violation the handler reads as "already done".
   `billing_writer` cannot read `workspaces`, `events` or `auth.users`, which
   `packages/db/test/billing-writer.test.ts` asserts by running AS the role.

5. Calendar delete, deferred twice now: `events.calendar_id` is `on delete restrict`, so
   it needs an answer for the events first. Calendar-move on edit is the same shape —
   `update_cloaked_event` (0011) takes no calendar id.

**Deferred by design:** booking, CRM, automations, external calendar sync, teams,
native iOS. **Payments are half-deferred now** — the plan surface and its schema exist, the
processor does not; see the plan/pricing section below and ADR 0007. **Independent security review is a hard gate before public launch.**

**Release prerequisites — things that must be checked against a REAL account before a door
opens, not before a branch merges.** Everything here is verified in code and unverified on the
wire, which is a normal state for this repo to be in and a bad one to forget it is in. The
distinction matters both ways: holding a branch for a check nothing local can run stalls work
for no gain, and opening a door without running it ships an unread assumption.

- **Before `NEXT_PUBLIC_CLOAKCAL_SIGNUPS_OPEN=1`:** run `loadSettingsSummary` against a
  throwaway account. The hub's four lines are pure-function tested for every branch, and their
  six PostgREST head counts have never executed — the fixture has no session, so every door
  reads "Demo" and the queries return nothing to compose. What a live pass would see and
  nothing else can: whether RLS scopes each count to the caller, whether `visibility_rules`
  with `.is('event_id', null)` matches what the Privacy page lists, and whether the
  `root_key_wraps` count survives its own policy. A wrong count here is silent and plausible,
  which is the family the contact-name ingest bug and the bytea spelling bug both belong to.
- **Before the undo strip or the Trash page are trusted:** 0031 is applied now, so what remains is to run the
  throwaway-account recipe. Everything about them is verified in code and unverified on the
  wire. The fixture has no session, so `TrashSection` has never issued one of its queries
  against PostgREST — whether RLS scopes each list to the caller, whether `recurrence_
  exceptions` is readable at all under its policy, and whether the private CloakStore opens a
  real trashed title are all unrun. Same family as the contact-name ingest bug: fixture-only
  green is not evidence for a path the fixture cannot take.
- **Before `CLOAKCAL_BILLING=1`:** the four items under item 4 above, unchanged.
- **Before the mobile redesign is called done: A REAL PHONE.** Every number in it is Chromium
  at a synthetic viewport. That proved layout and it cannot certify: the on-screen keyboard
  against a bottom-anchored sheet whose Save is its last element, `env(safe-area-inset-*)`
  against an actual notch and home indicator, Safari's toolbar behaviour against a `100dvh`
  shell whose document never scrolls, touch hit areas, or `navigator.standalone`. Playwright's
  WebKit is not Safari and has none of them. Minimum: one notched iPhone (Safari and
  installed), one Android (Chrome and installed), one 375px phone. The loading handoff's
  painted geometry is on this list too - see `e2e/loading-continuity.spec.ts` for the three
  ways of observing it locally that were tried and are unsound.
- **Before an install path ships:** ADR 0010's items 1-4. An installed shell has no browser
  back button, and today Android's Back leaves the calendar with a sheet open.
- **Before public launch:** the independent security review, unchanged.

Merging Settings does not wait on any of this. The branch is done; the door is not open.

## Deployment, as of 2026-08-16

**Vercel auto-deploys `main`, and `cloakcal.com` is live.** The project had no Git integration
at all once — every deploy came from the CLI, from a `master` ref, and the live site sat 14
commits behind. A push to `main` produces a production deploy now, and the apex serves it.

Four things about that are worth knowing, and the first is the one that bites.

- **CI DOES NOT GATE THE DEPLOY**, and it spent five commits red while shipping every one of
  them. `ci.yml` has no deploy step, so the two race. `main` failed from the
  `design/settings-cohesion` merge onward — `e2e/prelaunch.spec.ts` (both tests) and
  `e2e/settings.spec.ts`'s "demo display preferences" — and each red commit deployed anyway.
  **They passed locally and failed only on CI**, which is the tell: the e2e step had
  `NEXT_PUBLIC_CLOAKCAL_DEV_UNLOCK` and no Supabase variables, so `supabaseBrowser()` threw
  and `/recover` never rendered the form the spec looks for. Fixed 2026-08-16 by giving the
  **e2e step only** placeholder Supabase values. The `Build web` step still has none, on
  purpose: their absence there is what makes the `/account` prerender trap fire. Reproduce
  the CI environment before trusting a green local run —
  `mv apps/web/.env.local /tmp/` and put the two placeholders in its place.
- **The second red test was a genuinely broken test that only CI could see**, and it is worth
  knowing as a pattern. `settings.spec.ts`'s demo-preferences test opened Time & region and
  then asserted on all four controls, two of which live in APPEARANCE — which the accordion
  had just closed. **`toBeEnabled()` does not imply visible**, so those assertions passed
  against a hidden `<select>`, and the `selectOption` three lines later waited 30s for an
  element inside a collapsed `<details>`. Locally the `::details-content` transition left it
  hittable often enough to pass. Assert `toBeVisible()` alongside `toBeEnabled()` whenever a
  control lives in a band that something else may have closed.
- **Branch protection is not merely off, it is UNAVAILABLE.** This file used to say it "is the
  fix and is not yet turned on". The repo is private on a free GitHub plan, and both
  `/branches/main/protection` and `/rulesets` return 403 "Upgrade to GitHub Pro or make this
  repository public". So requiring the `CI` check needs a paid plan or a public repo, and
  until one of those happens the ONLY gate is whoever runs `git push`.
- **`cloakcal.com` is attached and serving over TLS** — apex returns HTTP/2 200 and is aliased
  on the production deployment alongside `cloakcal.vercel.app`. This file claimed for weeks
  that it was "registered and verified but attached to NO project", failing its handshake;
  that has not been true for a while. `www.cloakcal.com` is NOT configured and does not
  resolve. The zone is still on Porkbun, so **decline any prompt to move the nameservers to
  `vercel-dns.com`** — it carries the Zoho MX and every Resend record `pnpm email:setup` wrote.
- **Vercel Authentication is still on** (`ssoProtection: all_except_custom_domains`, password
  protection and trusted IPs both off), so every `*.vercel.app` URL bounces a non-team-member
  to an SSO page while the custom domain does not. **The apex is therefore genuinely public**,
  which it was not when this section was written. The thing keeping strangers out is
  `NEXT_PUBLIC_CLOAKCAL_SIGNUPS_OPEN` being unset and Supabase Auth's own sign-up switch, not
  the deployment protection.

The two Supabase variables are typed **Sensitive** on Production and Preview, which is why
`vercel env pull` returns `[SENSITIVE]` for them. Neither is secret. Retyping needs a delete
and re-add.

---

## Things that will waste your time if you do not know them

- **CLIPPING TEXT AND CLIPPING A BLOCK'S IDENTITY ARE DIFFERENT THINGS, and the fix for the
  first can cause the second.** Slicing a title through the middle of its glyphs was real, and
  the fix - clip whatever does not fit - blanked half the phone week into anonymous coloured
  rectangles. The calendar colours name a SOURCE, not a meaning, so colour plus position
  identifies nothing: a rectangle is not an event. A block must carry a legible title or be
  folded into a counted aggregate; there is no third state, and `e2e/block-legibility.spec.ts`
  walks every painted block on both viewports to say so.
- **`lanes` WAS COMPUTED PER DAY, NOT PER CLUSTER, AND HAD BEEN SINCE THE GRID WAS WRITTEN.**
  One 09:00-17:00 all-hands made every other event that day render at half width, including
  ones overlapping nothing. It only surfaced because a width-based rule started blanking those
  blocks - the narrowing itself had been invisible for months, because a half-width block that
  still shows its title looks like a design choice.
- **A `<dialog>` FALLBACK CANNOT BE OBSERVED BY HOLDING ITS NAVIGATION.** With the response for
  a route fully held, Next keeps the PREVIOUS route painted and never renders the loading
  boundary - which is exactly why `ui/nav-pending.tsx` exists in this product. A test that
  clicks and waits for the fallback waits its whole timeout for something that is not coming.
  Blocking the chunk files does not help either: the fallback-to-content swap is an inline
  script. Re-serving a truncated copy of the streamed HTML paints something whose layout is not
  the page's (an 850px header, measured). Pin the chrome on the SOURCE and pin the
  destination's values live, so the source test is checked against reality.
- **A LOADING FALLBACK THAT DRAWS THE REAL CLASSES CAN STILL DRIFT, AND ITS OWN PROSE BREAKS
  THE SCAN THAT WOULD CATCH IT.** `loading.tsx` explains the drift it is guarding, so it
  contains `<ThemeToggle />` as a QUOTATION - a positional check against the raw file found the
  comment's copy and failed on correct code. Strip comments first, line before block. And the
  comment explaining that trap must not SPELL a block-comment terminator, because writing one
  inside a block comment ends it: that cost a transform error one layer up.
- **BACKSLASH ESCAPES DO NOT SURVIVE EVERY LAYER THEY PASS THROUGH, and the failure names
  nothing.** A backslash-d in a template literal handed to `new RegExp` matches a literal
  `d`. A backslash-n written into a file through a shell heredoc can arrive as a REAL
  newline and terminate the regex literal it was inside. Both surface as a not-found or a
  syntax error pointing at the wrong place. Prefer a character class, a plain substring, or
  an index comparison over an escape that has to cross a boundary. This entry was itself
  written twice, because the first draft spelled the escape and the escape did the thing
  the sentence warns about.
- **`pnpm typecheck` NEVER COMPILES CSS.** A stray brace in a CSS module typechecks perfectly
  and 500s the page. Only `pnpm build` or loading the route sees it, which is worth knowing
  when a change is CSS-only and typecheck looks like enough.
- **A QUERY CONTAINER'S SIZE IS ITS CONTENT BOX, AND A BLIND SWEEP LOOKS EXACTLY LIKE A
  CLEAN ONE.** `container-type: size` on `.event` (week-grid) answers `@container
  (max-width: N)` with the element's CONTENT box: `.event` carries 8px side padding, a 3px
  left border and a 1px right border, so a block measuring 89.3px on screen answers with
  69.3. Thresholds written against the rendered size clip elements that had room. The second
  half is worse: the sweep asserting "no line overflows its block" then PASSED while
  checking nothing, because every line it would have measured was already clipped to 1x1 and
  skipped. **Make a sweep report how many things it inspected**, or it cannot tell you it
  found none from it looked at none. Same family as the `code()` helper that ate 3,884
  characters and reported a feature missing.
- **THE BUDGET IS INK, NOT LINE BOXES.** A line box is font-size plus leading and the
  leading is empty on both sides. Requiring the whole box to fit inside a block blanked a
  desktop 30-minute event that was 0.2px short of an 18.2px line box while its 14px of
  glyphs had 4px to spare -- the desktop week went from 14 titles to 3. The last line may
  hang into its own bottom half-leading, `(line - font) / 2`, and no further.
- **CLIPPING A CONTROL DELETES IT.** The visually-hidden pattern (`position: absolute;
  width: 1px; clip-path: inset(50%)`) keeps text in the accessibility tree, which is why it
  is right for a label. A 1x1 element is not hit-testable, so applying it to a BUTTON removes
  the control. `.privacyNoteButton` was in the week grid's clip rules for one run and took
  the owner's per-event visibility door off every short block, on desktop as well as phone.
  Four e2e tests caught it; nothing else would have.
- **A MEDIA OR CONTAINER BLOCK PLACED BEFORE THE RULE IT OVERRIDES LOSES ON SOURCE ORDER.**
  Neither adds specificity, so `@media { .headerEnd { margin-left: 0 } }` written above
  `.headerEnd { margin-left: auto }` does nothing at all. Hit twice in one pass, once with a
  comment confidently explaining an effect the rule did not have. Put conditional blocks
  AFTER the base rules they modify, and verify in the page rather than in your head.
- **A `\d` INSIDE A TEMPLATE LITERAL PASSED TO `new RegExp` SILENTLY BECOMES `d`.** The
  literal consumes the backslash before RegExp ever sees it, so a pattern built as
  "Show \d{4}" in backticks matches "Show dddd". It fails as a not-found rather than as a
  syntax error, which sends you looking at the page. Use a character class such as
  `[0-9-]+`, or double the backslash. Same family as the u2014 escape that hid an em dash
  from every source grep -- an escape sequence that one layer eats before the layer that
  cared about it ever ran.
- **A WORKTREE'S DEV SERVER WILL STEAL YOUR E2E RUN, AND PLAYWRIGHT CANNOT TELL.**
  `webServer.reuseExistingServer` is `!CI`, so a suite run while ANY other `next dev` holds
  the port attaches to that one instead of starting its own. Harmless when the other server
  is yours. Not harmless once agents run in git worktrees: a worktree is a DIFFERENT CHECKOUT
  of the same project on the same port. One night of this produced a full run reporting 365
  failures, an app regression in a file nothing had touched, and a LEAK-GATE HIT reporting
  decrypted event titles inside `app/page.css`. Every one of those was the other checkout.
  **The leak hit was TRUE, which is the part worth keeping**: that worktree had a CSS comment
  quoting a fixture calendar name, and `next dev` ships CSS comments verbatim, so the
  stylesheet really did contain it. It was written off here as a Playwright race before the
  port was checked -- an impossible-looking result is information, and the thing to check
  first is what produced it rather than the assertion that reported it. Corollary, cheap and
  absolute: **never put example content in a comment in a file that ships to the browser.**
  **Before believing any e2e failure, check what is on the port**
  (`netstat -ano | grep 3100`, then the PID's command line). Use
  `CLOAKCAL_E2E_PORT=3200 pnpm test:e2e` in a worktree.
- **`tail` ON A PLAYWRIGHT LOG HIDES THE FAILURE COUNT, AND A BACKGROUNDED COMMAND'S EXIT
  CODE IS THE WRAPPER'S.** Playwright prints `N failed` and its list ABOVE `skipped` and
  `passed`, so `tail -14` shows "540 passed" on a run that failed 21 -- and the harness's
  "[exited with code 0]" is the background wrapper, not pnpm. Both fired at once here and a
  red run was reported as clean. Grep `^  [0-9]+ (failed|passed|skipped|flaky)` and echo `$?`
  from inside the command.
- **AN EM DASH CAN ENTER USER-FACING COPY AS `\u2014` AND GREP WILL NOT SEE IT.** Six e2e
  specs assert no em dash renders, and they are right to — but they check the DOM, and a
  `grep -c` over the source counts characters. A `'\u2014'` escape inside a TypeScript string
  literal IS an em dash at runtime and is invisible to every source scan looking for the
  glyph. Introduced by a patch script and caught only because the assertion that was supposed
  to fail did not. Grep for `u2014` as well as for the character.
- **THE FIELD PASS NEVER REACHED `event-fields.module.css`, the most-used form in the
  product.** `--field-bg` / `--field-border` / `--radius-control` landed in auth, settings,
  billing and the calendar chrome; the create and edit sheets kept `--surface-overlay` with a
  `--border-default` hairline, which in LIGHT is #ffffff on #ffffff behind a ~1.6:1 outline —
  a WCAG 1.4.11 failure on every compose and edit. **axe cannot see it**: it measures TEXT
  contrast, so `compose.spec.ts` and `edit-event.spec.ts` both ran axe against this sheet
  open and both passed. Exactly the failure tokens.css predicts where it introduces
  --field-bg, including the reason ("whoever builds it is looking at dark").
- **`cloaked_fields` HAS NO FOREIGN KEY TO `events`.** It is polymorphic on (subject_type,
  subject_id) and its only FK is workspace_id, so `delete from events` does not touch the
  ciphertext. Any purge written the obvious way drops the row, passes every other test, and
  leaves the encrypted title, location and notes in the database forever while the product
  says they were permanently removed. 0031 deletes them explicitly and a db test asserts the
  count is zero. `visibility_rules.event_id` and `recurrence_exceptions.series_id` DO cascade;
  `audit_log` does not and cannot, because the table is append-only — which is why the
  privacy policy qualifies "permanently" instead of stating it flat.
- **`recurrence_exceptions` has a constraint that makes a naive purge fail.**
  `replacement_event_id` is `on delete set null` AND the table checks
  `(kind = 'moved') = (replacement_event_id is not null)`, so deleting an event a split
  detached would null the pointer and violate the check. Deleting the exception row instead
  is worse: the occurrence would REAPPEAR in its series. 0031 converts it to `cancelled`.
- **THERE ARE NO `-win32` VISUAL BASELINES, so `pnpm test:visual` is skipped on Windows.**
  Only `-darwin` and `-linux` are committed, and `playwright test --project=visual` reports
  "No tests found" rather than saying it skipped — which reads like a broken config. CLAUDE.md
  said "every committed baseline was -win32" for a long time and that has not been true since
  the darwin/linux sets landed. A change that alters the agenda or the landing cannot be
  screenshot-verified from a Windows machine at all; CI on ubuntu is the only check.
- **`ui/Button` now takes a `ref`, with no forwardRef.** React 19 passes `ref` to a function
  component as an ordinary prop, so only the TYPE had to widen
  (`ComponentPropsWithRef`) — which is why it looked like it already worked until the undo
  strip asked for one to focus itself.
- **A TRANSIENT UI STATE HELD OPEN BY A WALL-CLOCK DELAY IS A FLAKY TEST, and the flake shows
  up only in the full suite.** `e2e/nav-feel.spec.ts` asserts on two states that exist solely
  while a server navigation is in flight, and made them observable by holding the request for a
  fixed 800-1000ms. That budgets the observation window against a clock while the thing being
  observed is a SHARED `next dev` server: eight workers hit it at once, it compiles routes on
  demand, and its response time under load has no ceiling. Measured over three full-suite runs
  it failed on two, and passed 6/6 in isolation every time — the shape that reads as "flaky
  infrastructure" and is really a test that only works on an idle machine. **The failures were
  never the mechanism**: the pending marker was always found, and what timed out was the wait
  for the navigation to land afterwards, with a second of self-inflicted delay already spent.
  The route is released BY THE TEST now, once the marker has been seen, so the window is exactly
  as long as the assertion needs. That is strictly better than a bigger timeout: it takes the
  artificial delay off the critical path, and it makes the mid-flight state something the test
  proves it observed rather than something it hoped to be fast enough to catch.
- **`expect` WAITS 15s, NOT PLAYWRIGHT'S 5s, AND THAT IS ABOUT `next dev` RATHER THAN ABOUT
  SLOW ASSERTIONS.** The test server compiles a route on FIRST REQUEST and eight workers share
  one of them, so a `toHaveURL` after a click into a cold route is waiting on a compile with no
  ceiling under load. Deflaking nav-feel surfaced a second spec failing the same way on the
  next run, which is what settled it: over seven full-suite runs, two different specs failed on
  three of them, always with the mechanism working and only the wait expiring, and always
  passing in isolation. There are 34 bare `toHaveURL` assertions in `e2e/`, so fixing them one
  at a time is patching a class. **A failure in isolation means something different from a
  failure in the full suite** — check both before calling anything flaky, and if only the full
  suite fails, suspect a budget rather than a bug. **The 15s is an allowance for THIS test
  server and is not a statement about production navigation**: it says a compile-on-demand dev
  server shared by eight workers may take that long, and nothing about what a navigation should
  cost a user. Perceived latency is `nav-feel.spec.ts`'s subject, and any real budget would have
  to be measured against `next start`.
- **AN INLINE `= []` PROP DEFAULT IN A DEPENDENCY ARRAY IS AN UNBOUNDED EFFECT LOOP, AND IT
  PRESENTS AS CLICKS DOING NOTHING.** `CloakProvider` had `extraFields = []`, and
  `extraFields` is in its unlock effect's deps — a new array identity every render, so the
  effect re-ran, `setStore` re-rendered, forever. Four of the five call sites passed a
  memoised value as the JSDoc asks; the fifth omitted the prop, which reads like the one case
  the instruction cannot be about. **Nothing looks wrong**: the page paints, frames stay at
  16ms, `page.evaluate` answers instantly, and a synthetic `el.click()` works and does the
  right thing. The only symptom is that the renderer never finishes acknowledging a REAL input
  event, so every Playwright `click()` sits in its dispatch until the test times out with a
  call log that stops after "performing click action" and names nothing. Finding it took
  bisecting the page down to an empty `<main>` and watching it still fail. The default is a
  frozen module constant now, and `effect-deps.server.test.ts` sweeps for the pattern — it
  immediately found a second one, `holidays = {}` in `calendar-screen.tsx`, where it only
  defeated a `useMemo` and therefore showed no symptom at all.
- **`pnpm typecheck` DOES see typedRoutes, and that is worse than not seeing them.**
  `apps/web/tsconfig.json` includes BOTH `.next/types/**/*.ts` and `.next-prod/types/**/*.ts`,
  so the route union comes from whichever build wrote last — usually a stale `next dev` run.
  A new route fails typecheck until something regenerates the types, and a DELETED route keeps
  typechecking. `rm -rf apps/web/.next/types` then `pnpm build` is what resolves it. The
  standing advice is unchanged and now has a mechanism: `next build` is the only authority.
- **A local `pnpm test:e2e` used to need an untracked `apps/web/.env.local`, and failed four
  specs across three files without it.** `supabaseBrowser()` throws when either Supabase
  variable is absent, and `/recover` renders the form its specs look for only if it does not
  throw — so a fresh clone, or a machine where that file was moved aside to reproduce a CI
  build exactly as this file tells you to do, saw failures with nothing to do with the change
  under test. `playwright.config.ts`'s `webServer.env` now supplies the same placeholders CI
  does, with `??` so real values still win. The suite never reaches Supabase anyway.
- **Seven cold route compiles do not fit in one 30s Playwright budget.** `next dev` compiles
  on first request, and `csp.spec.ts`'s route walk grew from four routes to seven with the
  settings hub. It times out on the last one, which says nothing about CSP. `test.slow()`,
  not a shorter list — trimming would drop exactly the new routes the test exists to cover.
- **THE KDF IS WEBASSEMBLY, AND THE PRODUCTION CSP BLOCKED IT, SO NOBODY COULD SIGN IN.**
  `packages/crypto/src/kdf.ts` derives the master secret with Argon2id from `hash-wasm`, which
  calls `WebAssembly.compile()` — and a `script-src` with neither `'unsafe-eval'` nor
  `'wasm-unsafe-eval'` refuses to compile it, so the key ceremony throws and the account cannot
  be opened at all. **Every gate passed**: Playwright runs `next dev`, dev carries
  `'unsafe-eval'` for React Refresh, and `'unsafe-eval'` permits WASM as a side effect, so the
  browser suite exercised a policy production does not have. `security-headers.server.test.ts`
  compared dev and prod by DIRECTIVE NAME, which matched, while the difference lived in a
  SOURCE LIST. The fix is `'wasm-unsafe-eval'` and **never `'unsafe-eval'`** — the narrow
  keyword permits compiling a module, the broad one re-enables `eval()` of arbitrary strings in
  a bundle whose whole threat model is that XSS equals reading somebody's calendar. That file
  now also asserts the policy lets the product RUN, not only that it is tight; every other
  assertion in it was one-directional.
- **`stripe listen` forwards EVERY event on the account, not the ones your endpoint
  subscribes to.** One `stripe trigger customer.subscription.updated` produced ten deliveries —
  `plan.created`, `price.created`, `charge.succeeded`, `payment_method.attached`,
  `invoice.*` — and the handler was claiming an event id for each, taking a pooler connection
  to write a row nothing would ever read. With `max: 1` they queued until `connect_timeout`
  fired and responses took **thirty seconds**. The type check now runs BEFORE the database and
  the noise costs 8ms. It also stops `billing_events`, which has no DELETE grant and can never
  be pruned, filling up with events nobody handles.
- **`stripe listen` mints its OWN signing secret**, different from the registered endpoint's.
  An app configured with the endpoint's `whsec_` rejects every forwarded event with a 400 that
  looks exactly like a wrong secret. Start the dev server with the CLI's secret for local
  webhook work, and put the endpoint's back afterwards.
- **A closed union is only closed if one function owns it.** `lib/billing-error.ts` calls
  itself "a closed union mapped to sentences", and fifteen of seventeen error responses
  hand-rolled `Response.json({ error: '…' })` with a bare string literal. One of them emitted
  `no_customer`, which was not in the union, so it fell through to "We could not reach Stripe.
  Nothing was charged. Try again in a minute" — false on every clause, and it told the user to
  retry something that could never succeed. Routes go through `billingFailure(slug, status)`
  now, whose parameter type makes an invented slug a compile error. Same family as `--ease-out`.
- **Two independent pieces of state can render two mutually exclusive panels.** The billing
  band had `confirmingCancel: boolean` AND `proposal | null`, so switch-then-cancel stacked
  two confirmations with two live buttons on a screen about money — and neither e2e test saw
  it, because each opened one panel alone. One discriminated union makes it unrepresentable
  and deletes a boolean. `router.refresh()` also preserves client state, so a completed action
  leaves its own confirmation up unless something closes it.
- **postgres.js defaults `ssl` to FALSE, and the query string is the only other thing that
  sets it.** Options beat the query string, so `ssl: 'require'` in `server/billing/db.ts` is
  what makes TLS unskippable; without it, a `BILLING_DATABASE_URL` retyped without
  `?sslmode=require` sends the `billing_writer` password and every subscription row in
  cleartext, with no error and nothing here able to see it.
- **`on conflict (workspace_id)` does not catch a conflict on the OTHER two unique columns.**
  0028 makes `provider_customer_id` and `provider_subscription_id` UNIQUE, and a 23505 on
  either rolls the transaction back, un-claims the event, and 500s — so Stripe retries the
  same doomed event until it disables the endpoint. Reachable by reusing one test customer
  across two throwaway accounts, which is exactly what the recipe invites. Caught explicitly
  now and acknowledged with a 200, because retrying cannot resolve a unique violation.
- **Adding a workspace dependency can unlock rule 2's static gate.** `@cloakcal/db`'s main
  entry re-exports a module that imports `@cloakcal/crypto`, and
  `server-boundary.leak.test.ts` matched two literal specifiers. `apps/web` gaining
  `@cloakcal/db` — for the zero-import `/billing-queries` subpath — made
  `import { anything } from '@cloakcal/db'` legal in a server module. The sweep now knows
  about re-export laundering and allowlists the one subpath.
- **`new URL('<literal>', import.meta.url)` IS REWRITTEN BY VITE, SO A SOURCE-SCANNING TEST
  CANNOT READ ITS OWN SOURCE THAT WAY — BUT ONLY WHEN THE PATH IS A LITERAL.** Vite statically
  analyses that exact shape and turns it into an ASSET url, so in the jsdom projects it
  evaluates to `http://localhost:3000/apps/web/src/…` and `fileURLToPath` throws "The URL must
  be of scheme file". Put the same path in a VARIABLE and Vite cannot match it, so it is left
  alone and returns `file:///…`. That difference is invisible at the call site and it is the
  only reason `passkey-ui.client.test.ts`'s `read(path: string)` helper works while the obvious
  inline spelling in a new test does not — one file reads its sources fine and the next one
  cannot, with identical-looking code. **`import.meta.url` is `file:` in both cases**, so
  logging the base proves nothing and sends you looking at jsdom. Use
  `dirname(fileURLToPath(import.meta.url))` plus `join`: `fileURLToPath` on the STRING leaves
  no `new URL` literal for the transform to match. Measured with a probe, both spellings side
  by side in one file, not inferred.

- **This repo writes no semicolons, so `[^;]*` in a source-scanning regex runs to the end of
  the file.** A sweep meant to find a value import matched across every import above it and
  reported an `import type` line. Scan per statement, not with a character class that has
  nothing to stop at.
- **A wrong `whsec_` disables the webhook endpoint, and the app looks perfectly fine.** Every
  delivery 400s, Stripe retries for days, then disables the endpoint and emails whoever owns
  the Stripe account. Meanwhile nothing in the product looks wrong, because 0024 made absence
  mean Free — a subscription row that was never written is indistinguishable from a free
  account, and the property that makes a missing row SAFE is the same property that hides
  this. `pnpm billing:setup` printing `endpoint.status` on every run is the only watchdog in
  the whole design.
- **`current_period_end` is on the subscription ITEM, not the subscription.** `billing_mode:
  flexible` has been the default since API version 2025-09-30 and moved it; every guide
  written before 2025 reads `subscription.current_period_end`, which is now `undefined`. The
  failure is silent in both directions — optional in the SDK's types, nullable by design in
  0028 — so a wrong read stores `null` forever, no constraint fires, and the plan page says
  "renews —" for the life of the account. Same family as the bytea format mismatch.
- **Omitting `items[0].id` on a price swap ADDS a second item.** Stripe does not replace the
  first one, so the customer ends up subscribed to monthly AND yearly simultaneously, and
  there is no error anywhere. Changing a price also RESETS `quantity` to 1 unless it is
  carried over.
- **A redirect is the wrong answer for a JSON endpoint, and it reads as a Stripe bug.**
  `fetch` follows a 307 while PRESERVING the method, so a signed-out POST to
  `/api/billing/checkout` was re-POSTed to `/sign-in`, answered with 200 and a page of HTML,
  and surfaced as `res.json()` throwing a parse error. The user is told something went wrong
  when the truth is that their session expired. `guardFor()` in `middleware.ts` answers 401
  for `/api/*` now, and it is a pure function for the same reason `buildCsp` is: every
  Playwright project takes the dev-unlock early return, so a browser cannot test this at all.
- **`form-action 'self'` blocks a form POST that redirects to Stripe, in production only.**
  Whether `form-action` applies to redirect TARGETS is undefined in the CSP spec; Chrome and
  Safari enforce it, Firefox does not, and the development policy is deliberately looser. So
  nothing here can see it. Navigate with `window.location.href` after a `fetch`, which is a
  script-initiated top-level navigation and is governed by no CSP directive at all — and do
  NOT "fix" a blocked checkout by widening the policy. `security-headers.server.test.ts` pins
  that the production CSP names no Stripe origin, `form-action` stays `'self'` and `frame-src`
  stays `'none'`.
- **`plan-badge.server.test.ts`'s write-grep is BLIND to the billing writer.** It matches
  `from('subscriptions')…insert|update|upsert|delete`, a PostgREST shape, and the webhook
  speaks raw SQL over a direct connection. It stays, because it still guards the client path;
  `billing-boundary.server.test.ts` guards the other one, and asserts that exactly one file
  imports `server/billing/db` and that the chain to it is one hop deep.
- **The settings rail was illegible at 390px on four pages, and every gate passed.** `min-width:
  0` sat on `.navLink` — the flex CHILD — instead of `.nav`, the grid ITEM. A grid item's
  default min-width is its content, so the rail sized itself to all seven labels laid end to
  end, `overflow-x: auto` never engaged because there was nothing to overflow, and the children
  then shrank below their own `nowrap` text and printed on top of each other. axe does not
  measure legibility, the 44px sweep passed because the heights were right, and `never scrolls
  sideways` passed because the squashing is precisely what stopped the page scrolling sideways.
  It took opening a screenshot.
- **A FRAGMENT LINK SETS `location.hash` WHETHER OR NOT ANYTHING CARRIES THAT id, so asserting
  the URL after clicking a skip link proves the CLICK and never the LANDING.** `a11y.spec.ts`
  had a test called "a skip link that works" whose only outcome assertion was
  `toHaveURL(/#main$/)` -- which passes on a page with no `#main` at all. It also ran on `/`
  only, while the link itself lives in the ROOT layout and is therefore on the landing, the
  three auth pages, every settings route, both legal pages and both fallbacks. The two that had
  no `id="main"` were `not-found.tsx` and `error.tsx`: the bypass link was inert on exactly the
  two pages a lost or broken-out user is most likely to be reading, and it had been that way
  since the layout was written. **A global control needs a per-page assertion**, and the
  assertion has to name the TARGET (`expect(getByRole('main')).toHaveAttribute('id', 'main')`),
  not the side effect. Proved by deleting the id and watching the 404 case go red while `/`
  stayed green. The copy was wrong too and in the same shape: it said "Skip to calendar" on
  eleven routes, one of which is a calendar.

- **BRAND VOCABULARY MAY BE A VISIBLE LABEL, BUT IT MAY NOT BE THE WHOLE ACCESSIBLE NAME.**
  Both Cloak doors — the desktop header button and the phone bar's centre tile — were named by
  the bare word, which is the product's vocabulary (the mark, the verb `uncloak`,
  `--duration-cloak`, the sheet's heading) and describes no action. A sighted user at least gets
  the mark and the privileged centre slot as context; a screen-reader user got strictly less.
  The name is `CLOAK_DOOR_LABEL` now and the printed word is untouched. **The visible text must
  stay CONTAINED in the accessible name** (WCAG 2.5.3): voice control matches what the user
  SAYS, which is what they can see, against the ACCESSIBLE name, so replacing rather than
  extending it makes the control unreachable by voice while looking perfectly correct. One
  constant for two buttons, pinned from the other side by `cloakDoor` in `e2e/sheet.ts` — five
  specs had spelled out `{ name: 'Cloak', exact: true }` themselves, and that copy-paste is what
  made an underspecified label expensive to improve.
- **`aria-controls` ON A CONDITIONALLY MOUNTED DIALOG IS THE SKIP-LINK BUG IN NEW CLOTHES.** It
  is the obvious next suggestion on any disclosure button and it is wrong here: `CloakSheet`
  renders behind `{cloakOpen && …}`, so while the button is closed — which is exactly when a
  user meets the attribute — there is no element to reference. Its `<dialog>` also carries no
  `id` at all; the `useId()` value is bound to the `<h2>` for `aria-labelledby`. An IDREF to a
  missing element is the same defect as `href="#main"` on a page with no `#main`.
  `shell.spec.ts` asserts the ABSENCE so it does not get helpfully added back.
- **A MODAL `<dialog>` TAKES ITS OWN TRIGGER OUT OF THE ACCESSIBILITY TREE, SO `aria-expanded`
  ON THAT TRIGGER CAN ONLY EVER SAY "COLLAPSED".** `showModal()` puts the dialog in the top
  layer and makes the rest of the document inert; dumping Chromium's tree across a full
  open/close cycle showed the Cloak button with **zero nodes while the sheet was open**. So
  `aria-expanded="true"` is not unlikely to be heard, it is UNREACHABLE — an attribute with two
  values that exposes one, which turns "collapsed" into permanent speech on every focus that
  can never contrast with anything. It was carried on this button for exactly one commit, on
  the reasonable-sounding argument that focus returns to the opener so the state is perceivable
  on the way back; the return half is true and the conclusion still did not follow. The W3C
  modal-dialog pattern does not ask for it on a trigger: `aria-haspopup="dialog"` carries the
  popup type and the native element carries focus and modality. **`shell.spec.ts` asserts this
  absence too, and asserts the focus round trip directly** rather than through a state flag,
  because the behaviour is the thing worth protecting. The general lesson is the cheap one: an
  ARIA state is only worth adding if BOTH of its values can reach somebody, and the way to find
  out is to dump the tree rather than to reason about the spec.

- **`getByRole(role, { name })` matches the accessible name as a case-insensitive SUBSTRING.**
  A page-wide `/Switch to/` also matches the theme toggle's "Switch to light mode", which made
  four "this control must not exist here" assertions pass nothing. Scope a negative assertion
  to the thing it is denying, or it is asserting about the whole page.
- **`server-only` is not a dependency of this workspace.** Next aliases the bare specifier to
  its own compiled copy during a build, so `import 'server-only'` resolves inside `next build`
  and nowhere else — which is why, until billing, no test had ever imported a module from
  `src/server/` that carried the directive. `vitest.config.ts` aliases it to a stub; the real
  enforcement is still the bundler, which is why `pnpm build` runs before `pnpm test`.
- **A `max-width` hide rule can un-match itself.** The Today button overflowed the header at
  412px, the layout viewport expanded past the 480px threshold, and the rule that would have
  hidden it stopped matching — a feedback loop where the control causes the overflow that
  reveals the control. Chrome that phones should not see is hidden BY DEFAULT and shown at a
  `min-width`, which cannot feed the loop. And hide the WRAPPER, not the Button: `.button`'s
  own `display` beats a same-specificity override on CSS-module import order.
- **A sticky bar over a page scroller covers the last row's controls.** A delete
  confirmation's radios sat under the bottom nav — visible, unreachable by pointer, and
  Playwright will not scroll an element it considers already visible. The shell is now
  `height: 100dvh` with `main` as the scroller, so the nav owns its grid row and CANNOT
  overlap content. Do not revert it to `min-height` + page scroll.
- **Opacity stacked on tertiary ink fails AA.** The mini month dimmed neighbouring-month
  dates with `opacity: 0.6` over `--text-tertiary` and axe failed the whole page. Dim with a
  token that passes, never with opacity over ink that barely does.
- **The privacy chip inks are computed against COMPOSITED washes** — the alpha background
  over `--surface-raised`, hex-by-hex in `tokens.ts`, both themes. The raw `--privacy-*`
  colours are shape colours only; `--privacy-hidden` is 1.32:1 on dark raised BY DESIGN, so
  nothing may render a raw privacy colour as ink or rely on it being seen.

- **A server component importing a plain VALUE out of a `'use client'` module gets a
  reference proxy, not the value — and inside a Suspense fallback that failure renders as
  a DOUBLED PAGE rather than an error.** Exporting the settings section list from
  `settings-screen.tsx` and importing it into `app/settings/loading.tsx` threw
  `SECTIONS.map is not a function` on every load; because the throw happened in the
  fallback, `/settings` came back with two `<h1>`s, two `<main>`s and ten `<details>` where
  five belonged, which looks like a rendering bug and not an import one. Typecheck passes
  either way. Shared lists that a fallback and a screen both draw from live in `lib/` —
  that is what `lib/calendar-views.ts` and `lib/settings-sections.ts` are for, and both say
  so in their headers.
- **`pnpm typecheck` does NOT see typedRoutes, so a green typecheck is not evidence a
  computed href compiles.** The route union is generated during `next build`, so
  `router.push(someFunction(...))` typechecks fine and then fails the build with "Argument
  of type 'string' is not assignable to parameter of type 'RouteImpl<string>'". Inlined
  template literals happen to satisfy it, which is why moving an href behind a function is
  what surfaces it. `lib/audiences.ts` holds the one `as Route` cast; `WeekLink`'s UrlObject
  form exists for the same reason.
- **A grid item defaults to content-based `min-width`, and `min-width: 0` on the CONTAINER
  does nothing about it.** Telling the settings summary titles not to wrap sized each
  `<details>` card to title-plus-state and pushed /settings into horizontal overflow at
  390px, ignoring the `text-overflow: ellipsis` sitting right there. Nothing else here can
  see that: axe does not measure it, the 44px sweep does not measure it, and visual
  baselines are per-project so none of them compares a page against its own viewport.
  `never scrolls sideways` in `e2e/settings.spec.ts` is the guard, and it belongs on any
  page that grows a nowrap element.
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
- **A SIGNED-IN USER COULD DELETE THEIR OWN WORKSPACE, AND THE CASCADE TOOK THE BILLING ROW
  WITH IT.** `workspaces_delete` (0002) granted it and 0024 hung `subscriptions` off the
  workspace with `on delete cascade`, so one request — `DELETE /rest/v1/workspaces?id=eq.<mine>`
  — destroyed the local record of a paid subscription. **A referential action checks neither
  RLS nor the privileges on the referencing table**, which is why 0024's own revoke on
  `subscriptions` did nothing about this route. Harmless while nobody is charged; unreconcilable
  the moment Stripe is wired, and `billing_writer` cannot repair it because it cannot see
  `workspaces`. Closed by 0030, as an ALLOWLIST (`revoke all`, then `grant select, insert,
  update`) plus dropping the policy — the grant is the enforcement, the policy is dropped so no
  artifact implies a capability nobody holds. `subscription.test.ts` used to DEMONSTRATE this
  delete and call it "harmless today"; it now asserts the refusal.
- **Deletion is still by email, deliberately, and no button should say otherwise.**
  `auth.users` is unreachable in-band: rule 4 bans the service key, `security-posture.test.ts`
  bans SECURITY DEFINER, and `auth.users` has no RLS to scope a narrow role — so an
  `account_deleter` role could destroy ANY account, inverting the exact property ADR 0007 uses
  to justify `billing_writer`. `profiles` (no delete policy) and `audit_log` (`revoke update,
  delete`) are equally out of reach, the latter by design. A "Delete account" button that
  leaves an email and a user id on file is a worse lie than the honest sentence already there.
  0030 removed the crude route, so content erasure is now a GAP rather than a duplicate — a
  written trade, not an oversight.
- **DELETE must be refused by PRIVILEGE, never by a missing policy.** `profiles` had DELETE
  granted since 0001 with no delete policy, so a delete quietly matched nothing — and would
  have opened the day anyone added a policy for an unrelated reason, in a diff about something
  else. `security-posture.test.ts` now sweeps every public table for "DELETE granted, no policy
  admitting one", with a debt list that must stay empty, plus a control asserting `events`,
  `contacts` and `root_key_wraps` ARE still deletable — otherwise the sweep could be satisfied
  by revoking the verb everywhere and breaking the product.
- **`packages/db/test/harness.ts` carries a HARDCODED migration list**, so a new `.sql` file is
  invisible to every DB test until it is added there. The suite goes green against a schema
  that does not include your migration, which reads exactly like "my change broke nothing".
  Same orphan shape as `playwright.config.ts`'s `testMatch` and the visual baselines.
- **Five surfaces justified readable times with "because reminders need them"**, a feature that
  is not merely unbuilt but UNWRITABLE — `create_cloaked_event` takes no reminder parameter,
  `event-fields.tsx` has no control, and `reminder_offsets` has been `'{}'` on every row since
  0001. Same family as the export claim: copy cashing a cheque on a capability that does not
  exist. They now give the unconditional reason (a calendar cannot place, repeat or lay out an
  event without times), and `legal-claims.server.test.ts` carries a `Reminders` capability so
  the claim and an implementation have to move together.
- **THE PRIVACY POLICY CLAIMED A FEATURE THAT DID NOT EXIST, AND IT SAT IN THE STATUTORY
  RIGHTS SECTION.** *(The claim is true now — export shipped — but the shape is the lesson.)* `lib/legal.ts` said "You can export your calendar as a standard .ics file
  at any time, from Settings" — in the present tense, naming a location — while
  `settings-screen.tsx` said "Export — Coming soon" and no such control had ever been built.
  Two lines below it, the same section invokes UK/EU/California portability rights, so the
  false sentence was the page's answer to a statutory obligation. **The bullet directly above
  it gets deletion exactly right** ("There is no button for this yet, and we would rather say
  so than point you at one that is not there"), which is the tell: one author held the rule
  and the paragraph beside it did not. The product UI was honest everywhere; only the legal
  document overstated. `legal-claims.server.test.ts` now pairs every present-tense capability
  claim in that file against the control or flag backing it, because prose is the one surface
  in this repo with no compiler and no test — which is exactly why it drifted first.
- **`packages/domain/src/ical.ts` is NOT the .ics exporter**, whatever its name suggests. It
  converts a series spec to and from an RRULE and exists for one hazard: `DTSTART` is
  local-with-TZID while `UNTIL` must be UTC and is inclusive. The file emitter is `ics.ts`
  beside it. ADR 0007 said `ical.ts` "is already written", which read as "export is nearly
  done" — it is the hard sub-problem, not the feature.
- **EXPORT IS BUILT, AND EVERY BYTE OF IT IS ASSEMBLED IN THE BROWSER.** The server cannot
  read titles, so it cannot build the file: `/api/export` serves the whole account's
  CIPHERTEXT and `components/export-calendar.tsx` (`'use client'`) decrypts, emits and
  downloads. It owns a PRIVATE CloakStore rather than the shared one — not for availability
  (Settings is inside CloakProvider) but for blast radius: pushing every event through the
  shared store would leave the user's whole decrypted history resident in page state to serve
  one click. It `lock()`s in a `finally`. Series export as a RULE, never as expanded dates,
  or the wall-clock guarantee dies at the boundary.
- **A source-scanning `code()` helper must strip LINE comments BEFORE block comments.** The
  obvious order is wrong: a line comment mentioning a path like `/api/*` opens a block the
  matcher closes at the next `*/` it finds, swallowing everything between. It ate 3,884
  characters of `export-calendar.tsx` and made a sweep report a feature missing while it sat
  four lines below the comment that hid it. Fixed in `legal-claims`, `billing-boundary` and
  `billing-routes`; no file triggered it in the latter two, which is exactly why it was worth
  fixing — a blind sweep and a passing sweep look identical. Same family as the `[^;]*`
  warning further down: a source regex with nothing to stop it runs until something else does.
- **.ics folding is measured in OCTETS, not characters** (RFC 5545 §3.1, 75 of them). Folding
  by `.length` passes every test written in English and corrupts the first title written in
  a language that is not — an emoji is four octets and one character. `ics.ts` walks
  codepoints and measures encoded width; `ics.test.ts` pins it with a CJK/emoji case.
  Escaping is backslash FIRST (§3.3.11), and colon is NOT escaped in TEXT.
- **No VTIMEZONE is emitted, deliberately.** §3.6.5 wants one for every TZID referenced.
  Generating it means a second implementation of the DST rules `resolveLocal` already owns,
  and two implementations of a DST rule disagree eventually — the lesson ADR 0001 is built on.
  Google, Apple, Outlook and Thunderbird all resolve IANA TZIDs directly; a strict validator
  will complain. Stated in `ics.ts` rather than discovered.
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

## The references specify a LIGHT calendar, and we built a dark one

Corrected 2026-08-12. `tokens.css` claimed "the brand board is dark throughout" and that drove
the default. The board's chrome is dark; all three rendered PRODUCT screens are on white.
Light is not the extrapolation — it is the only theme the calendar is drawn in.

`docs/calendar-design.md` is the full read of what the board actually specifies: a left
sidebar with a mini month and a colour-coded calendars list, a Today button and a Week/Month
toggle, event blocks carrying the privacy level as a second line, a mobile week strip, a
five-item bottom nav with **Cloak** in the centre slot, and the Event Visibility sheet. Almost
none of it is built. `PRIVACY_LEVELS` in `packages/ui/src/tokens.ts` has been sitting unused
since M0 and is what those chips and second lines render from.

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

**There are two recovery routes now, and the second one needs no memory.** A passkey wraps
the same root key everything else opens (ADR 0005, migration 0023): register one under
Settings, Security; unlock with it; and use it on `/recover` instead of the 24 words. Face
ID, Touch ID or a device PIN is the whole ceremony. The phrase is the last resort it was
always meant to be rather than the only way in.

**The security argument is user verification, and it is why this does not weaken anything.**
The PRF output only exists after the authenticator verifies a human, so the passkey route
cannot be walked by someone sitting at an unlocked laptop. That is a property of THAT route,
not of the account: a live session plus a known password still changes a password, as it
always could. No key material
lands in storage. That is the opposite trade from making the vault readable, which was
considered and rejected — see the rewrite of ADR 0006 for what that would have cost.

**Two prompts, and the copy has to say so.** PRF output is not reliably returned from
`create()` (Safari hands back `enabled: true` and no results), so registering creates the
credential and immediately asserts against it. The user sees two biometric prompts back to
back, which reads as the first having failed unless told otherwise. Nothing is written if
the second yields no PRF output: a credential with no wrap is a passkey that opens nothing.

**Removing a passkey refuses when it is the last way in.** 0006's header claimed the
single-table design made "you must always have at least one wrap" a one-query invariant. It
did, and nobody had written the query, because until passkeys nothing in the product could
delete a wrap at all. It matters most for OAuth accounts, which have no password wrap, so
their passkeys may be all they have.

**What to ask a real person about recovery, and why the obvious question is the wrong one.**
Ask **"You forgot your password. What would you do?"**, and only then **"What if you also lost
the recovery phrase?"** The single question people reach for first — "what happens if you lose
the phrase" — encodes a model that stopped being true when passkeys landed: it assumes the 24
words are the only route, so it tests whether somebody memorised a warning rather than whether
they can find the way in. The two-step version tests the model that actually shipped. The first
question surfaces whether passkeys and phrase rotation are FINDABLE at the moment they are
needed; the second surfaces whether the irreversible boundary is understood BEFORE somebody
crosses it, which is the only time understanding it is worth anything. Nothing in this repo can
answer either — they are questions about comprehension, and the passkey flow additionally has
never met a real authenticator.

**None of it has met a real authenticator.** Every test is source-level or PGlite; a mocked
authenticator only proves the API was called as intended. Safari's PRF behaviour and the
two-prompt flow are unverified until someone runs the throwaway-account recipe in a browser.
**Migration 0023 was applied to production all along**, contrary to what this file said for
weeks. Verified 2026-08-15 against the live project: `credential_id` and `prf_salt` both
exist, all four paired constraints are there, `root_key_wraps_one_per_credential` is there,
and the kind check already lists `passkey`. The stale claim had a cost — the plan page listed
passkeys as "coming soon" on the strength of it. **0024 and 0025 went up 2026-08-15 and are
verified live**: `subscriptions` grants `authenticated=SELECT` and nothing else, anon has no
grant on it at all, its one policy is `SELECT` to `authenticated`, RLS is enabled and forced,
and it holds zero rows (absence is Free). TRUNCATE, REFERENCES, TRIGGER and MAINTAIN are now
granted to `anon`/`authenticated` on **zero** tables, down from all sixteen, and the
`postgres` default ACL for new tables reads `anon=arwd, authenticated=arwd` — DML only, so a
new table no longer arrives pre-granted TRUNCATE.

**Device pairing is demoted, not deleted.** Spec §Recovery names three routes; passkeys are
the second. The pairing crypto (`packages/crypto/src/device.ts`, ECDH P-256) and schema
(`root_key_wraps.kind = 'device'`) stay done, tested and unused. It would still be a
convenience, but it is no longer the fix for the phrase being the only route, and the
roadmap copy says so.

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

## The project agents

Six specialists live in `.claude/agents/`, one per category of work this repo actually
has: `cloak-boundary` (crypto, keys, leaks, privacy claims), `db-rpc` (migrations,
functions, RLS), `calendar-ui` (front end, tokens, copy), `a11y-testing` (tests, axe,
baselines, the environmental traps), `recurrence-domain` (time, DST, splits), and
`senior-review` (the last gate: simplicity, maintainability, guarantees staying real).

Three rules keep them coherent:
- **This file is authoritative.** Agents cite CLAUDE.md and the ADRs; they do not restate
  them. If an agent and this file disagree, this file wins and the agent is wrong.
- **One source of truth per rule.** Each rule is stated in full in exactly one agent; the
  others reference it by name. Restating a rule in a second file is how two copies drift.
- **Declared handoffs.** Schema touching encrypted fields: `db-rpc` ↔ `cloak-boundary`.
  Every new or changed control: `calendar-ui` → `a11y-testing`. Everything ends at
  `senior-review`, which runs on the full diff after the specialists pass.

Their external claims carry source URLs so they can be re-verified when they date; the
research snapshots behind them were taken 2026-08.

## Working style

Match the surrounding code: this repo comments the *why*, especially where a decision looks
odd or diverges from a standard. If you discover a real defect while working, fix it and say
so plainly rather than working around it. If a test is inconvenient, that is usually the
test doing its job — weakening a guarantee to make a test pass is how guarantees stop being
real.
