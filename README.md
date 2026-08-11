# CloakCal

A privacy-first calendar. Not everything is for everyone.

**Works today:** sign up, sign in, the first-run key ceremony with a 24-word recovery phrase,
unlock, agenda and week views, week navigation, View As, and the full create / edit / delete
loop on an event — including series splits, which ask whether you mean this occurrence, this
and everything after, or the whole series. Plus account recovery: `/recover` takes the phrase
and a new password, `/account` changes a password deliberately, and both re-wrap the root key
rather than re-encrypting anything.

**Not built yet:** day and month views (the navigation shows them **disabled** rather than as
controls that silently do nothing — spec §10), device pairing, per-occurrence delete, and
reading visibility rules from the database — View As currently demonstrates the policy engine
against demo rules rather than controlling anything.

`CLAUDE.md` is the honest, current state. See
[docs/screen-inventory.md](docs/screen-inventory.md) for the 26 Phase 1 screens and which of
them the brand references actually specify, [docs/brand.md](docs/brand.md) for the mark and
the typeface, and the `docs/M*-REVIEW.md` packets for how each milestone was signed off.

## Architecture

The full plan lives in the approved architecture document. The three rules that matter most:

1. **Hybrid time model.** The server stores event *times*, recurrence and availability in
   plaintext so booking, reminders and conflict detection work. Cloak encrypts event
   *content* client-side. CloakCal is not zero-knowledge and must never be marketed as such.
2. **One policy engine.** `packages/policy` is the only place a field-visibility decision is
   made. The server uses it to redact; the client uses the same package for View As. Postgres
   RLS is coarse row authorisation only.
3. **Tier discipline.** Every field is Tier A (server-processable) or Tier B (client-encrypted).
   There is no plaintext `title` column anywhere, and a test fails the build if one appears.

## Layout

```
packages/db/           schema, RLS migrations, CRUD service, PGlite harness, seed
packages/domain/       recurrence, DST, edit scopes, iCal boundary
packages/crypto/       AES-256-GCM, HKDF per-field keys, canonical AAD
packages/cloak-store/  browser-only, non-serializable decryption boundary
packages/ui/           design tokens (dark + light), contrast-tested
packages/policy/       visibility engine — the only place a field decision is made
apps/web/              Next.js PWA — agenda and week views, auth, event CRUD
e2e/                   leak, accessibility and visual suites
tools/                 fixture generator, email setup, brand asset renderer

access envelopes       multi-recipient sharing      — not built
offline outbox         conflict resolution          — not built
```

## Verify

```bash
pnpm install
pnpm typecheck
pnpm test          # everything
pnpm test:db       # schema, constraints, RLS workspace isolation
pnpm test:leak     # privacy leakage: no Tier B content in any Tier A column
pnpm test:domain   # recurrence, DST, edit scopes
pnpm build         # production build (required before test:leak)
npx playwright test  # E2E and accessibility
pnpm brand:assets  # regenerate icons from the mark; output is committed
```

**`pnpm build` comes before `pnpm test` on a fresh clone.** The leak suite inspects the
prerendered HTML and RSC payloads in `apps/web/.next-prod`, and with no build present it
FAILS rather than skips — deliberately, because a privacy gate that skips reports green while
checking nothing. One failed suite on a clean checkout is that gate working.

The **visual** project only runs where baselines for that platform are committed, and today
that is macOS only. Generate a set for a new platform with `pnpm test:visual
--update-snapshots`; for the linux set CI needs, run the `Visual baselines (linux)` workflow
and commit the artifact.

E2E runs against the dev server on purpose: the development key legitimately cannot
unlock a production build, and relaxing that gate to suit a test would trade a real
guarantee for a convenient one. Production artifacts are covered by `test:leak`.

Postgres tests run on PGlite — real Postgres compiled to WASM. No Docker required.

## Database

Supabase project `bnjbgjzbddypqtoolunz` (`CloakCal`, us-east-2, Postgres 17). Migrations in
`packages/db/migrations` are the source of truth and are applied in order.
