# CloakCal

A privacy-first calendar. Not everything is for everyone.

**Current milestone: M1 complete.** Recurrence and DST, the iCalendar boundary, event
CRUD with five enforced gates, the client-only decryption boundary, and a PWA shell with
the agenda view.

Week, day and month views are not built. The navigation shows them **disabled** rather
than as controls that silently do nothing — spec §10. See
[docs/screen-inventory.md](docs/screen-inventory.md) for the 26 Phase 1 screens and which
of them the brand references actually specify, and [docs/M1-REVIEW.md](docs/M1-REVIEW.md)
for the current review packet.

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
apps/web/              Next.js PWA — agenda view
e2e/                   leak, accessibility and visual suites
tools/                 build-time fixture generator

packages/policy/       visibility engine            — M2
access envelopes       multi-recipient sharing      — M3
offline outbox         conflict resolution          — M4
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
npx playwright test  # E2E, accessibility, visual
```

E2E runs against the dev server on purpose: the development key legitimately cannot
unlock a production build, and relaxing that gate to suit a test would trade a real
guarantee for a convenient one. Production artifacts are covered by `test:leak`.

Postgres tests run on PGlite — real Postgres compiled to WASM. No Docker required.

## Database

Supabase project `bnjbgjzbddypqtoolunz` (`CloakCal`, us-east-2, Postgres 17). Migrations in
`packages/db/migrations` are the source of truth and are applied in order.
