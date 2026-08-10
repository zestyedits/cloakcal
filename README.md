# CloakCal

A privacy-first calendar. Not everything is for everyone.

**Current milestone: M0 complete.** Foundation, schema, RLS, design tokens, test harness.
No application UI yet — that is M1.

## What this is not (yet)

There is deliberately no running app. Per spec §10, a control that does not work is not
shipped, so nothing decorative has been rendered. See [docs/screen-inventory.md](docs/screen-inventory.md)
for the 26 Phase 1 screens and which of them the brand references actually specify.

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
packages/db/       schema, RLS migrations, PGlite test harness, seed data
packages/ui/       design tokens (dark + light), contrast tests
packages/policy/   visibility engine            — M2
packages/crypto/   Cloak boundary               — M3
packages/domain/   events, recurrence, conflict — M1
apps/web/          Next.js PWA                  — M1
```

## Verify

```bash
pnpm install
pnpm typecheck
pnpm test          # everything
pnpm test:db       # schema, constraints, RLS workspace isolation
pnpm test:leak     # privacy leakage: no Tier B content in any Tier A column
pnpm test:vectors  # policy engine, server vs client agreement (M2)
```

Postgres tests run on PGlite — real Postgres compiled to WASM. No Docker required.

## Database

Supabase project `bnjbgjzbddypqtoolunz` (`CloakCal`, us-east-2, Postgres 17). Migrations in
`packages/db/migrations` are the source of truth and are applied in order.
