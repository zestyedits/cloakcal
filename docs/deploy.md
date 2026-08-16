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

## Billing

Nothing here is set today, and billing is therefore off in every environment. The whole
block is fail-closed as a **set**: `billingConfig()` returns null unless every one of the
six is present and well-formed, so a half-configured deployment renders no purchase control
at all rather than a button whose route 500s.

| Variable | Value | Secret |
|---|---|---|
| `CLOAKCAL_BILLING` | `1` to open the door. Unset means closed. | no |
| `STRIPE_SECRET_KEY` | `sk_test_…` | **yes** |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` | **yes** |
| `BILLING_DATABASE_URL` | `postgresql://billing_writer.…` | **yes** |
| `STRIPE_PRICE_PRO_MONTHLY` | `price_…` | no |
| `STRIPE_PRICE_PRO_ANNUAL` | `price_…` | no |
| `STRIPE_PORTAL_CONFIGURATION_ID` | `bpc_…` | no |

Get all six from `pnpm billing:setup`, which creates the Stripe objects over the API and
prints them.

**`CLOAKCAL_BILLING` is deliberately NOT `NEXT_PUBLIC_`,** unlike the sign-ups flag. Sign-ups
had to be public because the browser talks to Supabase directly, so that flag is the door and
Supabase Auth is the wall. Every billing action goes through one of our own route handlers,
so here the server *is* the wall — and a server-only variable can be flipped without a
redeploy, because Next does not inline it.

**A live key disables billing rather than enabling it.** `billingConfig()` refuses anything
but `sk_test_`. That is how "nothing takes real money before the independent security review"
is a property of the build instead of a note somebody has to remember. Removing that check is
a decision with an ADR behind it, not a config change.

**The three secrets must be typed Sensitive,** which means `vercel env pull` returns the
literal `[SENSITIVE]` for them while still printing a success line and exiting 0.
`billingConfig()` refuses that string on purpose — the same trap that already cost this
project once on the Supabase values.

### `billing_writer` needs a password, and it is not in this repo

Migration 0028 creates the role `NOLOGIN` with no password, because a password in a committed
migration is a password in the git history forever. **Until somebody runs this by hand in the
Supabase SQL editor, the webhook cannot connect and every delivery 500s — after checkout has
already succeeded.**

Generate a URL-safe password so there is no percent-encoding step to get wrong:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Then, in the SQL editor, **one line**:

```sql
alter role billing_writer with login password '<generated>';
```

The `search_path`, the two timeouts and the connection limit used to live here too, and they
are in **migration 0029** now. They are limits rather than secrets, and three source files
cite them as safety guarantees — a guarantee that lives only in a runbook is a guarantee
nobody has. The password is the one part that genuinely cannot go in a migration, because a
password in a committed migration is a password in the git history forever.

### Verify the connection string before the first checkout, not after

**This is the highest-risk unverified claim in the whole design.** Supavisor identifies the
tenant from the last dot-segment of the username, and the documented form for a *custom* role
is `<role>.<project-ref>`. If that is wrong, every webhook 500s — and by then Checkout has
already succeeded, so somebody has paid and is sitting on Free. Nothing in this repo can see
it: PGlite proves the SQL and the e2e suite never opens a socket.

```bash
psql "postgresql://billing_writer.bnjbgjzbddypqtoolunz:<pw>@<pooler-host>:6543/postgres?sslmode=require" \
     -c "select current_user, current_setting('is_superuser')"
# expect:  billing_writer | off
```

Read the pooler host off Supabase → Connect → **Transaction pooler**. It is not derivable and
it has changed over time. Do **not** use `db.<ref>.supabase.co`: that is the direct connection,
it is IPv6-only, and a Vercel function cannot reach it.

**If it fails, stop and rethink. Do not fall back to `postgres.<ref>` plus `set role`.** ADR
0007 spends a paragraph on exactly that: a `reset role` undoes the entire boundary in one
statement, and the credential in Vercel becomes a service-role key with a politeness step in
front of it. The honest fallback is the *session* pooler on 5432 with the same custom-role
username, which trades connection efficiency rather than security.

### Rotating the password has an unavoidable window

A role has one password, so there is always a gap. The order is: set the new value in Vercel,
redeploy, then `alter role`, then verify. The window between the last two is a minute of 500s,
which Stripe retries through. Doing it the other way round is a window of 500s that lasts as
long as the deploy.

### The Stripe MCP server, and what it is not

`.mcp.json` adds Stripe's own hosted MCP server at project scope. It is OAuth-based, so
provisioning the Product, the Prices and the webhook endpoint can happen without a secret key
ever being pasted into a file — which is the whole reason it is there.

**It does not replace `STRIPE_SECRET_KEY`.** The MCP is a tool for whoever is setting Stripe
up; the running application still needs its own credential to make server-to-server calls. And
unlike the Supabase MCP, whose `execute_sql` and `apply_migration` are denied outright by the
permission classifier, this one has no equivalent to the one SQL statement `billing_writer`
still needs by hand.

It requires a one-time authorisation (`/mcp` in an interactive session). Until then it reports
`Needs authentication` and does nothing.

## Stripe settings that are not in this repo

Six things live in the Stripe dashboard. `pnpm billing:setup` prints them at the end of every
run rather than silently skipping them.

1. **Receipt emails** (Settings → Customer emails). OFF by default in test mode, so nobody
   gets a receipt and the integration looks broken.
2. **Branding** (Settings → Branding) — logo, icon and accent for Checkout and the portal.
   Not writable over the API for your own account.
3. **Portal activation**, live mode only. Test mode works without it.
4. **Retry and dunning schedule** (Settings → Subscriptions and emails → smart retries).
   Decides how long a `past_due` account stays that way before Stripe gives up.
5. **Statement descriptor** (Settings → Public business details). This is the text on a
   cardholder's statement, and an unrecognised one is a chargeback.
6. **Rolling a webhook signing secret in place.** There is no API call for it; the script can
   only delete and recreate, with `--recreate-endpoint`, which mints a new secret.
