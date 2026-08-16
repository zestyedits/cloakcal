import 'server-only'

/**
 * Whether billing is switched on, and everything it needs to run.
 *
 * FAIL-CLOSED BY CONSTRUCTION, and the construction is the point: `billingConfig()` returns
 * null unless EVERY value is present and well-formed, so a half-configured deployment renders
 * no purchase control rather than a button whose route 500s. `lib/signups.ts` states the
 * general argument for a gate that defaults shut; this one goes further, because a gate
 * standing beside five secrets can drift out of step with them and a boolean cannot see that.
 *
 * THE FLAG IS SERVER-ONLY, UNLIKE SIGN-UPS, and the difference is where the wall is. Sign-ups
 * had to be `NEXT_PUBLIC_` because the browser talks to Supabase directly, so that flag is the
 * door and Supabase Auth is the wall. Every billing action goes through one of our own route
 * handlers, so here the server IS the wall — nothing in a bundle needs to know, and a
 * server-only variable can be flipped without a redeploy because Next does not inline it.
 *
 * TEST MODE IS ENFORCED HERE RATHER THAN PROMISED IN A DOCUMENT. A key that is not `sk_test_`
 * disables billing instead of enabling it, so the decision that nothing takes real money
 * before the independent security review is a property of the build rather than something
 * somebody has to remember. See ADR 0009 §6.
 *
 * NONE OF THIS IS A SERVICE-ROLE KEY. `BILLING_DATABASE_URL` connects as `billing_writer`,
 * which holds privileges on `subscriptions` and `billing_events` and on nothing else in the
 * database — `packages/db/test/billing-writer.test.ts` proves that by running AS the role.
 * Rule 4 stands: no credential in this system can read or rewrite everything.
 */

export interface BillingConfig {
  readonly secretKey: string
  readonly webhookSecret: string
  readonly databaseUrl: string
  readonly priceMonthly: string
  readonly priceAnnual: string
  readonly portalConfigurationId: string
  /**
   * Always `'test'` today, because nothing else is accepted. It is a field rather than a
   * derived helper so that allowing live keys later is one edit HERE, and every surface that
   * renders the mode keeps reading the same value.
   */
  readonly mode: 'test'
}

/**
 * What `vercel env pull` writes for a variable typed Sensitive, while still printing
 * `✓ Created` and exiting 0.
 *
 * Rejected explicitly rather than left to the prefix checks. This exact placeholder has
 * already cost this project once: `supabaseBrowser()` only throws on `undefined`, so a
 * `[SENSITIVE]` value sailed past the loud-failure guard and surfaced much later as an
 * inexplicable network error. A prefix check would catch it for five of the six variables
 * here by luck; naming it catches all six on purpose.
 */
const PULL_PLACEHOLDER = '[SENSITIVE]'

/** Present, non-empty, not the pull placeholder, and starting with what it must start with. */
function shaped(value: string | undefined, prefix: string): string | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === PULL_PLACEHOLDER) return null
  return trimmed.startsWith(prefix) ? trimmed : null
}

/**
 * Every value billing needs, or null.
 *
 * NEVER PUT A VALUE IN A MESSAGE OR A LOG. This function returns null and says nothing about
 * which variable was wrong, which is deliberate: four of the six are secrets, and a
 * diagnostic naming the malformed one is a diagnostic that eventually prints a key. The
 * operator's tool for finding out which is missing is `pnpm billing:setup`, which runs
 * against their own terminal rather than a server log. `billing-config.server.test.ts` pins
 * the silence.
 *
 * Two consumers, two meanings for null. The user-facing routes treat it as 404 — from the
 * caller's side the feature does not exist. The webhook treats it as 503, so Stripe keeps
 * retrying rather than counting a permanent failure toward endpoint disablement.
 */
export function billingConfig(): BillingConfig | null {
  const secretKey = shaped(process.env.STRIPE_SECRET_KEY, 'sk_test_')
  const webhookSecret = shaped(process.env.STRIPE_WEBHOOK_SECRET, 'whsec_')
  // The role is named in the URL, so a connection string for `postgres` — which on Supabase
  // is effectively a service-role credential — cannot be pasted here by accident. That is a
  // shape check standing in for rule 4 at the one place the rule could be broken silently.
  const databaseUrl = shaped(process.env.BILLING_DATABASE_URL, 'postgresql://billing_writer.')
  const priceMonthly = shaped(process.env.STRIPE_PRICE_PRO_MONTHLY, 'price_')
  const priceAnnual = shaped(process.env.STRIPE_PRICE_PRO_ANNUAL, 'price_')
  const portalConfigurationId = shaped(process.env.STRIPE_PORTAL_CONFIGURATION_ID, 'bpc_')

  if (
    secretKey === null ||
    webhookSecret === null ||
    databaseUrl === null ||
    priceMonthly === null ||
    priceAnnual === null ||
    portalConfigurationId === null
  ) {
    return null
  }

  // The two prices must differ. Pointing both at the same price id is a configuration
  // mistake with no error anywhere: the yearly card would charge $8 a month, or the monthly
  // card $72 a year, and Stripe would accept either without complaint.
  if (priceMonthly === priceAnnual) return null

  return {
    secretKey,
    webhookSecret,
    databaseUrl,
    priceMonthly,
    priceAnnual,
    portalConfigurationId,
    mode: 'test',
  }
}

/**
 * The door, ANDed with the wall.
 *
 * A flag set without keys would render a purchase button whose route cannot work, which is
 * the wrong way round: the failure would surface at the click, on the one screen where a user
 * is trying to give us money. So the flag alone is never enough.
 */
export function billingEnabled(): boolean {
  return process.env.CLOAKCAL_BILLING === '1' && billingConfig() !== null
}
