/**
 * One command to stand up Stripe for CloakCal, over the API, with no dashboard clicking.
 *
 * Run:
 *   pnpm billing:setup            # do it
 *   pnpm billing:setup --dry-run  # validate everything, write nothing
 *
 * IDEMPOTENT. Re-running is safe and is the intended way to resume after a failure. Every
 * object is found by a caller-chosen identifier — a product id, a price `lookup_key`, a
 * metadata tag, an endpoint URL — never by name and never by `products.search`, whose index
 * lags by up to a minute and would therefore create a duplicate on exactly the re-run that
 * "resume after a failure" invites.
 *
 * IT WILL NOT ACCEPT A LIVE KEY. `sk_live_` is refused at preflight, matching
 * `server/billing/config.ts`, which disables billing rather than enabling it for the same
 * input. CLAUDE.md's rule is that nothing takes real money before the independent security
 * review; this is one of the two places that rule is enforced instead of remembered.
 *
 * PRICES COME FROM `PLANS` AND ARE NEVER TYPED HERE. See tools/stripe-prices.ts, which is the
 * pure half and is unit-tested. If you find yourself writing `800` in this file, the number
 * has acquired a second home and the pricing page and the charge can now disagree.
 *
 * WHAT IT CANNOT DO. Six things are dashboard-only and are printed at the end rather than
 * silently skipped — receipts being the one that will actually confuse somebody, because they
 * are OFF by default in test mode and their absence reads as a broken integration.
 */

import Stripe from 'stripe'
import { planById } from '../apps/web/src/lib/plans.js'
import { lookupKeyFor, needsNewPrice, priceParamsFor } from './stripe-prices.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface Config {
  readonly secretKey: string
  readonly siteUrl: string
  readonly dryRun: boolean
  readonly recreateEndpoint: boolean
}

const required = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${name} is not set. Run:  cp tools/stripe-setup.env.example .env.stripe-setup  then ` +
        `fill it in. The .env.stripe-setup path is gitignored; the template is not.`,
    )
  }
  return value.trim()
}

function loadConfig(): Config {
  return {
    secretKey: required('STRIPE_SECRET_KEY'),
    // Used ONLY for the webhook endpoint URL, which must be a fixed public address Stripe can
    // reach. The checkout and portal routes derive their origin from the REQUEST instead, so a
    // preview deployment sends a preview user back to the preview and not to production.
    siteUrl: (process.env['SITE_URL']?.trim() ?? 'https://cloakcal.com').replace(/\/+$/, ''),
    dryRun: process.argv.includes('--dry-run'),
    recreateEndpoint: process.argv.includes('--recreate-endpoint'),
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

let step = 0
const heading = (text: string) => {
  step += 1
  console.log(`\n\x1b[1m${step}. ${text}\x1b[0m`)
}
const ok = (text: string) => console.log(`   \x1b[32m✓\x1b[0m ${text}`)
const info = (text: string) => console.log(`   \x1b[2m·\x1b[0m ${text}`)
const warn = (text: string) => console.log(`   \x1b[33m!\x1b[0m ${text}`)

class SetupError extends Error {
  constructor(message: string, readonly fix?: string) {
    super(message)
    this.name = 'SetupError'
  }
}

// ---------------------------------------------------------------------------
// Constants that are OURS to choose, and are therefore stable
// ---------------------------------------------------------------------------

/**
 * A caller-chosen product id, which `Product` is one of the few Stripe resources to accept.
 *
 * The obvious alternative — `products.search({ query: "metadata['x']:'y'" })` — has an
 * indexing lag of up to a minute, so create-then-immediately-rerun would miss and create a
 * second product. A deterministic id has no lag and no ambiguity.
 */
const PRODUCT_ID = 'cloakcal_pro'

/** Tags the portal configuration so a later run finds the one it made. */
const CONFIG_TAG = 'cloakcal_v1'

/**
 * PINNED, AND CREATE-ONLY. An endpoint's API version decides the SHAPE of what Stripe posts
 * to us, and it defaults to the ACCOUNT default, which can silently differ from the version
 * this repo's `stripe` package was built against. Stripe does not let it be updated after
 * creation, so a mismatch means delete and recreate — which mints a new signing secret.
 */
const API_VERSION = '2026-07-29.dahlia'

/**
 * The minimal set, and the reasoning for what is absent.
 *
 * `customer.subscription.updated` already fires on every status transition including
 * `past_due` and `unpaid`, so the invoice events add nothing to ENTITLEMENT, which is the only
 * thing this webhook writes. They become necessary the day we send dunning email; we do not.
 *
 * `invoice.created` is deliberately NOT here and must not be added casually: if the endpoint
 * fails to return 2xx for it, Stripe delays finalising ALL auto-collection invoices for up to
 * 72 hours. That is a real outage mode bought for no benefit.
 */
const EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]

// ---------------------------------------------------------------------------

async function preflight(config: Config, stripe: Stripe): Promise<void> {
  heading('Checking the key')

  if (!config.secretKey.startsWith('sk_test_')) {
    throw new SetupError(
      'STRIPE_SECRET_KEY is not a test-mode secret key.',
      'This project is test-mode only until the independent security review. ' +
        'apps/web/src/server/billing/config.ts refuses anything but sk_test_ too, so a live ' +
        'key would disable billing rather than enable it. Use a key from a sandbox: ' +
        'https://dashboard.stripe.com/sandboxes',
    )
  }

  const account = await stripe.accounts.retrieve()
  ok(`${account.settings?.dashboard?.display_name ?? account.id} (test mode)`)
  info(`charges_enabled: ${String(account.charges_enabled)}`)
  if (!account.charges_enabled) {
    info('test mode works without activation; live mode will not. Not a problem today.')
  }
}

async function ensureProduct(config: Config, stripe: Stripe): Promise<string> {
  heading('Product')
  const tier = planById('pro')

  const fields = {
    name: `CloakCal ${tier.name}`,
    description: tier.tagline,
    metadata: { cloakcal: CONFIG_TAG },
  }

  try {
    const existing = await stripe.products.retrieve(PRODUCT_ID)
    ok(`reusing ${existing.id}`)
    if (config.dryRun) {
      info('dry run: would refresh name and description from lib/plans.ts')
      return existing.id
    }
    // Refreshed on every run so `lib/plans.ts` stays the source of truth for the words a
    // customer sees on Stripe's own checkout page, not just the ones on ours.
    await stripe.products.update(PRODUCT_ID, fields)
    ok('name and description refreshed from lib/plans.ts')
    return existing.id
  } catch (error) {
    if (!(error instanceof Stripe.errors.StripeInvalidRequestError) || error.statusCode !== 404) {
      throw error
    }
  }

  if (config.dryRun) {
    warn(`dry run: would create product ${PRODUCT_ID}`)
    return PRODUCT_ID
  }

  const created = await stripe.products.create({ id: PRODUCT_ID, ...fields })
  ok(`created ${created.id}`)
  return created.id
}

async function ensurePrice(
  config: Config,
  stripe: Stripe,
  productId: string,
  cadence: 'monthly' | 'annual',
): Promise<string> {
  const tier = planById('pro')
  const desired = priceParamsFor(tier, cadence)
  const key = lookupKeyFor(tier.id, cadence, desired.currency)

  const found = await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 })
  const existing = found.data[0]

  if (existing !== undefined && !needsNewPrice(existing, desired)) {
    ok(`${cadence}: reusing ${existing.id} (${desired.unit_amount / 100} ${desired.currency})`)
    return existing.id
  }

  if (existing !== undefined) {
    /*
     * A PRICE AMOUNT IS IMMUTABLE, so this is a migration rather than an edit — and the part
     * that matters is what happens to people already paying. Archiving a price DOES NOT move
     * its subscribers: they keep being charged the old amount indefinitely, with nothing in
     * Stripe or here saying so. Refusing to be quiet about that is the whole point of this
     * branch.
     */
    const subscribed = await stripe.subscriptions.list({ price: existing.id, status: 'all', limit: 1 })
    warn(
      `${cadence}: lib/plans.ts says ${desired.unit_amount / 100} ${desired.currency}, ` +
        `Stripe has ${(existing.unit_amount ?? 0) / 100} ${existing.currency}`,
    )
    if (subscribed.data.length > 0) {
      warn(
        `${subscribed.data.length}+ subscription(s) are on the OLD price and archiving will ` +
          `NOT move them. They keep paying the old amount until each one is migrated by hand.`,
      )
    }
  }

  if (config.dryRun) {
    warn(`dry run: would create ${cadence} price at ${desired.unit_amount / 100} ${desired.currency}`)
    return `price_dryrun_${cadence}`
  }

  const created = await stripe.prices.create({
    product: productId,
    lookup_key: key,
    // Moves the key off the old price atomically, so there is never a moment where two active
    // prices claim it or none does.
    transfer_lookup_key: existing !== undefined,
    ...desired,
  })
  ok(`${cadence}: created ${created.id}`)

  if (existing !== undefined) {
    // Archived, never deleted. Same posture as `billing_events` having no DELETE grant: the
    // record of what somebody was charged has to outlive the decision to charge something else.
    await stripe.prices.update(existing.id, { active: false })
    warn(`archived ${existing.id}. Update STRIPE_PRICE_PRO_${cadence.toUpperCase()} and redeploy.`)
  }

  return created.id
}

async function ensurePortal(
  config: Config,
  stripe: Stripe,
  productId: string,
  monthly: string,
  annual: string,
): Promise<string> {
  heading('Customer portal configuration')

  /*
   * WHAT THE PORTAL IS FOR HERE, WHICH IS NOT WHAT IT IS USUALLY FOR. Cancel, resume and the
   * cadence switch all happen on our own settings page through the Subscriptions API — the
   * portal cannot be iframed, so a redirect would fail the requirement outright (ADR 0009 §2).
   * This configuration exists for the ONE action that genuinely cannot live on our domain,
   * which is taking a card number, plus the 3DS confirmation fallback.
   *
   * `subscription_cancel` and `subscription_update` are still enabled anyway, because a deep
   * link 400s when its feature is disabled and those two are the fallbacks. Enabling a feature
   * is not the same as routing users through it.
   */
  const features: Stripe.BillingPortal.ConfigurationCreateParams.Features = {
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    // Email only. An address is data this product does not need and would be collected purely
    // to satisfy tax automation that is switched off. A billing email is separately useful,
    // because it is deliberately NOT the login email (the login address is the KDF salt).
    customer_update: { enabled: true, allowed_updates: ['email'] },
    subscription_cancel: {
      enabled: true,
      mode: 'at_period_end',
      proration_behavior: 'none',
      /*
       * `cancellation_reason` IS OMITTED, NOT SET TO `{ enabled: false }`.
       *
       * Stripe requires `features[subscription_cancel][cancellation_reason][options]` whenever
       * the object is present AT ALL — passing `{ enabled: false }` is rejected for a missing
       * `options` list it will never use. So the way to switch it off is to not mention it,
       * and the run below prints what Stripe actually stored rather than assuming.
       *
       * Off because asking a privacy product's departing customer WHY, and storing the answer
       * at a payment processor, is off-brand in a way a reviewer notices before a customer does.
       */
    },
    subscription_update: {
      enabled: true,
      default_allowed_updates: ['price'],
      proration_behavior: 'create_prorations',
      products: [{ product: productId, prices: [monthly, annual] }],
    },
  }

  const fields = {
    business_profile: {
      headline: 'CloakCal',
      privacy_policy_url: `${config.siteUrl}/privacy`,
      terms_of_service_url: `${config.siteUrl}/terms`,
    },
    default_return_url: `${config.siteUrl}/settings/plan`,
    metadata: { cloakcal: CONFIG_TAG },
    features,
  }

  const listed = await stripe.billingPortal.configurations.list({ limit: 100 })
  const existing = listed.data.find((c) => c.metadata?.['cloakcal'] === CONFIG_TAG)

  if (config.dryRun) {
    warn(`dry run: would ${existing === undefined ? 'create' : `update ${existing.id}`}`)
    return existing?.id ?? 'bpc_dryrun'
  }

  const saved =
    existing === undefined
      ? await stripe.billingPortal.configurations.create(fields)
      : await stripe.billingPortal.configurations.update(existing.id, fields)

  ok(`${existing === undefined ? 'created' : 'updated'} ${saved.id}`)

  /*
   * READ BACK WHAT STRIPE ACTUALLY STORED, because two of these are things we asked for by
   * omission rather than by value, and an omission that defaulted the wrong way is invisible.
   * `cancellation_reason` in particular cannot be set to false explicitly (see above), so the
   * only way to know it is off is to look.
   */
  const cancel = saved.features.subscription_cancel
  info(`cancel: ${cancel.enabled ? 'enabled' : 'DISABLED'}, mode ${String(cancel.mode)}`)
  if (cancel.cancellation_reason?.enabled === true) {
    warn(
      'Stripe defaulted the cancellation-reason survey ON. It asks a departing customer why ' +
        'and stores the answer at the processor. Turn it off in the dashboard.',
    )
  } else {
    ok('cancellation-reason survey is off')
  }
  info(`payment method update: ${saved.features.payment_method_update.enabled ? 'on' : 'OFF'}`)
  // Passed EXPLICITLY on every session rather than relying on "the default configuration",
  // because a dashboard edit to the default would silently change what the app does.
  info('pass this as STRIPE_PORTAL_CONFIGURATION_ID; the app never uses the account default')
  return saved.id
}

async function ensureWebhook(config: Config, stripe: Stripe): Promise<string | null> {
  heading('Webhook endpoint')
  const url = `${config.siteUrl}/api/billing/webhook`

  const listed = await stripe.webhookEndpoints.list({ limit: 100 })
  let existing = listed.data.find((e) => e.url === url)

  if (existing !== undefined && config.recreateEndpoint) {
    if (config.dryRun) {
      warn(`dry run: would DELETE and recreate ${existing.id}, minting a new signing secret`)
      return null
    }
    await stripe.webhookEndpoints.del(existing.id)
    warn(`deleted ${existing.id} — a NEW signing secret follows and the old one stops working`)
    existing = undefined
  }

  if (existing !== undefined) {
    ok(`reusing ${existing.id}`)

    /*
     * STATUS ON EVERY RUN, AND IT IS THE ONLY WATCHDOG IN THIS WHOLE DESIGN.
     *
     * A wrong signing secret 400s every delivery. Stripe retries for days, then DISABLES the
     * endpoint. Meanwhile the app looks perfect, because 0024 made absence mean Free — so a
     * subscription row that was never written is indistinguishable from a free account, and
     * the property that makes a missing row safe is the same property that hides this.
     */
    if (existing.status !== 'enabled') {
      warn(
        `STATUS IS "${existing.status}". Stripe disables an endpoint after sustained failures, ` +
          `and a disabled endpoint is invisible from inside the app: paid accounts simply stay ` +
          `on Free. Re-enable it in the dashboard and check STRIPE_WEBHOOK_SECRET.`,
      )
    } else {
      ok('status: enabled')
    }

    if (existing.api_version !== API_VERSION) {
      warn(
        `pinned to ${existing.api_version ?? 'the account default'}, not ${API_VERSION}. ` +
          `api_version is CREATE-ONLY, so this needs --recreate-endpoint, which mints a new ` +
          `signing secret you must then set in Vercel.`,
      )
    }

    const missing = EVENTS.filter((e) => !existing.enabled_events.includes(e))
    if (missing.length > 0) {
      if (config.dryRun) {
        warn(`dry run: would add ${missing.join(', ')}`)
      } else {
        await stripe.webhookEndpoints.update(existing.id, { enabled_events: EVENTS })
        ok(`added ${missing.join(', ')}`)
      }
    }

    info('signing secret unchanged — keep the STRIPE_WEBHOOK_SECRET you already have')
    info('lost it? there is no roll-secret API call. Use --recreate-endpoint, or the dashboard.')
    return null
  }

  if (config.dryRun) {
    warn(`dry run: would create an endpoint at ${url}`)
    return null
  }

  const created = await stripe.webhookEndpoints.create({
    url,
    api_version: API_VERSION,
    description: 'CloakCal — subscription lifecycle',
    metadata: { cloakcal: CONFIG_TAG },
    enabled_events: EVENTS,
  })
  ok(`created ${created.id}`)
  // Returned ONLY on create, by Stripe, once. There is no way to read it back.
  return created.secret ?? null
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig()
  // No apiVersion: since v12 the SDK sends the version it was built against, and that version
  // is what makes its TypeScript types accurate. The npm pin IS the API version.
  const stripe = new Stripe(config.secretKey)

  console.log('\n\x1b[1mStripe setup — CloakCal\x1b[0m')
  console.log('\x1b[2mProduct, two prices, portal configuration, webhook endpoint\x1b[0m')
  if (config.dryRun) console.log('\x1b[33mDRY RUN — nothing will be written\x1b[0m')

  await preflight(config, stripe)

  const productId = await ensureProduct(config, stripe)

  heading('Prices')
  const monthly = await ensurePrice(config, stripe, productId, 'monthly')
  const annual = await ensurePrice(config, stripe, productId, 'annual')

  const portalId = await ensurePortal(config, stripe, productId, monthly, annual)
  const secret = await ensureWebhook(config, stripe)

  console.log('\n\x1b[1mEnvironment\x1b[0m')
  console.log('\x1b[2mAll six are required. billingConfig() returns null if ANY is missing,')
  console.log('so a half-configured deployment renders no purchase control at all.\x1b[0m\n')
  console.log(`STRIPE_SECRET_KEY=${config.secretKey.slice(0, 12)}…`)
  /*
   * PRINTED IN FULL, DELIBERATELY, unlike the key above — and the asymmetry is the point
   * rather than an oversight. The API key already exists somewhere you can re-read it; a
   * webhook signing secret is returned by Stripe EXACTLY ONCE, on create, and there is no API
   * call that reads it back. Truncating it here would mean the only copy is unrecoverable and
   * the endpoint has to be deleted and recreated. It lands in terminal scrollback and shell
   * history, which is a real cost, so: paste it into Vercel and clear your history.
   */
  console.log(`STRIPE_WEBHOOK_SECRET=${secret ?? '<unchanged — keep the one you have>'}`)
  if (secret !== null) {
    warn('that secret is shown ONCE and cannot be read back. Store it now, then clear scrollback.')
  }
  console.log(`STRIPE_PRICE_PRO_MONTHLY=${monthly}`)
  console.log(`STRIPE_PRICE_PRO_ANNUAL=${annual}`)
  console.log(`STRIPE_PORTAL_CONFIGURATION_ID=${portalId}`)
  console.log('BILLING_DATABASE_URL=postgresql://billing_writer.<ref>:<pw>@<pooler>:6543/postgres')
  console.log('\nCLOAKCAL_BILLING=1   # the door. Unset means off, whatever else is set.')
  console.log(
    '\n\x1b[2mThe four secrets must be typed Sensitive on Vercel, which means `vercel env pull`\n' +
      'returns the literal [SENSITIVE] for them. billingConfig() refuses that string on\n' +
      'purpose — it is the trap that already cost this project once on the Supabase values.\x1b[0m',
  )

  printManualSteps()
}

function printManualSteps(): void {
  console.log('\n\x1b[1mStill manual — not exposed by any API:\x1b[0m')
  const steps: [string, string][] = [
    [
      'Receipt emails',
      'Settings -> Customer emails -> "Successful payments" and "Failed payments". ' +
        'OFF by default in test mode, so NOBODY gets a receipt and the integration looks broken.',
    ],
    [
      'Branding',
      'Settings -> Branding. Logo, icon and accent for Checkout and the portal. Not writable ' +
        'over the API for your own account.',
    ],
    [
      'Portal activation (live mode only)',
      'Test mode works without it. Live mode does not. Moot until after the security review.',
    ],
    [
      'Retry and dunning schedule',
      'Settings -> Subscriptions and emails -> smart retries. Decides how long a past_due ' +
        'account stays past_due before Stripe gives up.',
    ],
    [
      'Statement descriptor',
      'Settings -> Public business details. This is the text on a cardholder’s statement, ' +
        'and an unrecognised one is a chargeback.',
    ],
    [
      'Rolling the webhook signing secret in place',
      'Dashboard only. This script can only delete and recreate, with --recreate-endpoint.',
    ],
  ]
  for (const [title, detail] of steps) {
    console.log(`\n   \x1b[1m${title}\x1b[0m`)
    console.log(`   \x1b[2m${detail}\x1b[0m`)
  }

  console.log('\n\x1b[1mAnd one that is not Stripe at all:\x1b[0m')
  console.log(
    '\n   \x1b[1mbilling_writer needs a password\x1b[0m\n' +
      '   \x1b[2mMigration 0028 creates the role NOLOGIN with no password, because a password in\n' +
      '   a committed migration is a password in the git history forever. Until somebody runs\n' +
      '   the `alter role` block in docs/deploy.md by hand, the webhook cannot connect and\n' +
      '   every delivery 500s — AFTER checkout has already succeeded.\x1b[0m',
  )
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`\n\x1b[31m✗ ${message}\x1b[0m`)
  if (error instanceof SetupError && error.fix !== undefined) {
    console.error(`\n\x1b[33mFix:\x1b[0m ${error.fix}`)
  }
  process.exitCode = 1
})
