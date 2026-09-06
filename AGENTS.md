# Base44 dev environment — CloakCal

## What this is
A pnpm monorepo: a Next.js 15 PWA (`apps/web`) plus workspace packages (`packages/*`).
Node >= 22, pnpm 10.13.1 (declared via `packageManager`; activate with corepack).

## How it runs here
`docker-compose.base44.yml` runs a single `web` service (node:22-bookworm-slim) with the
repo bind-mounted at `/repo`. It installs deps with pnpm and runs
`next dev -H 0.0.0.0 -p 3000` from `apps/web`. The web entry point is host port 3000.

## Backend: real Supabase (not dev-fixture mode)
The app runs against the user's existing remote Supabase project
(`bnjbgjzbddypqtoolunz`). `NEXT_PUBLIC_CLOAKCAL_DEV_UNLOCK=0` in `.env.base44-defaults`,
so the real auth + data path is live: middleware checks Supabase sessions, `/` shows the
landing page for signed-out visitors, and signing up runs the real key ceremony.

The Supabase **publishable (anon) key** is delivered via the platform-managed env file
(`/run/base44/app.env`) and overrides the placeholder in `.env.base44-defaults`. It is
public by design — RLS authorizes, not the key. There is no service-role key and must
never be one.

To temporarily fall back to the committed demo fixture (offline, no auth), set
`NEXT_PUBLIC_CLOAKCAL_DEV_UNLOCK=1` in `.env.base44-defaults` and restart.

## Billing: disabled (fail-closed)
The Stripe integration is intact but **fail-closed by design**: without
`CLOAKCAL_BILLING=1` and all six Stripe env vars, `billingEnabled()` returns false and no
purchase controls render. The billing routes return 404. No Stripe secrets are configured.

The user requested switching to Base44 Payments (wix_payments), but the
`suggest_payments_installation` tool is not available to the imported-app engineer, so
that switch could not be actioned. Billing stays safely disabled until that's resolved.

## Preview hostname
Next.js gates dev assets/HMR by ORIGIN. `apps/web/next.config.ts` derives
`allowedDevOrigins` from `BASE44_PUBLIC_HOST_SUFFIX` (passed into the service env) so the
preview's external origin is allowed. Do NOT add `--turbopack` to dev/build — see the
load-bearing comment in `next.config.ts`.

## Verify
- `docker compose -f docker-compose.base44.yml up -d`
- `curl -sf -H "Host: external-preview.example.com" http://localhost:3000/` → 200 with
  `<title>CloakCal</title>` and the Agenda view.
- Logs show live compilation (`✓ Compiled / in ...`) — confirms it serves cloned source,
  not a prebuilt bundle.

## Tests (run on host, not in the compose service)
`pnpm build` must precede `pnpm test` on a fresh clone (the leak suite inspects the
prerendered output in `apps/web/.next-prod`). See README.md "Verify" section.
