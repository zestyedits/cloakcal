# Deploying CloakCal

Vercel project `cloakcal` in `zestyedits-projects`. Supabase project `bnjbgjzbddypqtoolunz`
(`CloakCal`, us-east-2).

## Preview

```bash
vercel --cwd . --yes --scope zestyedits-projects
```

Preview only. **Production (`--prod`) needs explicit permission every time.**

A preview deploy does not take the `cloakcal.vercel.app` alias — that belongs to production,
so the short URL 404s until something is promoted. Test the deployment-specific URL the CLI
prints, and remember that a 200 from it is not proof: deployments are behind Vercel
Authentication (`ssoProtection: all_except_custom_domains`), which 302s to `vercel.com/sso-api`
for anyone not signed in to the team. Assert on page content, not status codes.

## Two things that are not obvious

**1. `next` is a root devDependency purely for Vercel's framework detection.**

Vercel reads `package.json` at the project's Root Directory to decide which builder to use.
This project's Root Directory is the repo root (the CLI cannot set it, and the API rejects
the CLI's stored token), so without `next` there, every deploy fails with *"No Next.js
version detected"*. The actual build still runs `pnpm --filter @cloakcal/web build` from
`vercel.json`; the root copy is never executed. It is not entirely a fiction either —
`playwright.config.ts` spawns `next dev` from the root.

If Root Directory is ever set to `apps/web` in the dashboard, this dependency can go.

**2. `outputDirectory` is `apps/web/.next-prod`, not `.next`.**

`next.config.ts` sets `distDir` from `NEXT_DIST_DIR`, and the build script sets it to
`.next-prod` so that `next dev` cannot clobber the prerendered HTML and RSC payloads the
build-output leak suite inspects. Vercel runs that same script, so the output lands in
`.next-prod` there too.

## Environment

Preview and production both need:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://bnjbgjzbddypqtoolunz.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` |

Both are public by design: the publishable key identifies the project and authorises
nothing. RLS is what authorises, and it is enforced in Postgres.

**There is no service-role key, and there must never be one.** It bypasses RLS entirely.

`NEXT_PUBLIC_CLOAKCAL_DEV_UNLOCK` must never be set on Vercel. It is refused by production
builds anyway — `NODE_ENV` is inlined at build time — but setting it would be a signal that
someone misunderstood what it does.

## Supabase settings that are not in this repo

Two things live in the Supabase dashboard and will bite on a fresh deploy:

1. **Email confirmation is ON.** Sign-up sends a confirmation link, and the built-in SMTP
   only delivers to team members' addresses and is heavily rate limited. Either turn
   confirmation off for now (Authentication → Sign In / Providers), or configure a real SMTP
   sender before anyone else is invited.
2. **Redirect URLs.** Authentication → URL Configuration must list the deployed origin, or a
   confirmation link bounces the user to `localhost`.

Neither is reachable through the Supabase MCP tools, so both are manual.
