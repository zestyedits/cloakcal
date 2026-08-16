import { afterEach, describe, expect, it, vi } from 'vitest'
import { billingConfig, billingEnabled } from '../src/server/billing/config'

/**
 * The billing gate is fail-closed, and every assertion here exists because the opposite
 * default is the tempting one. `signups.client.test.ts` makes the same argument for its flag;
 * this one has more to protect, because forgetting a value here does not merely open a door,
 * it can open a door onto real money.
 */

/** A complete, valid set. Individual tests break exactly one thing at a time. */
const GOOD = {
  STRIPE_SECRET_KEY: 'sk_test_abc123',
  STRIPE_WEBHOOK_SECRET: 'whsec_abc123',
  BILLING_DATABASE_URL: 'postgresql://billing_writer.projectref:pw@host.pooler.supabase.com:6543/postgres',
  STRIPE_PRICE_PRO_MONTHLY: 'price_monthly',
  STRIPE_PRICE_PRO_ANNUAL: 'price_annual',
  STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_abc123',
} as const

type Vars = Partial<Record<keyof typeof GOOD | 'CLOAKCAL_BILLING', string | undefined>>

function stub(overrides: Vars = {}): void {
  for (const [name, value] of Object.entries({ ...GOOD, ...overrides })) {
    vi.stubEnv(name, value)
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('billingConfig', () => {
  it('returns every value when the environment is complete', () => {
    stub()
    expect(billingConfig()).toEqual({
      secretKey: GOOD.STRIPE_SECRET_KEY,
      webhookSecret: GOOD.STRIPE_WEBHOOK_SECRET,
      databaseUrl: GOOD.BILLING_DATABASE_URL,
      priceMonthly: GOOD.STRIPE_PRICE_PRO_MONTHLY,
      priceAnnual: GOOD.STRIPE_PRICE_PRO_ANNUAL,
      portalConfigurationId: GOOD.STRIPE_PORTAL_CONFIGURATION_ID,
      mode: 'test',
    })
  })

  it('is null when any single value is missing', () => {
    for (const name of Object.keys(GOOD) as (keyof typeof GOOD)[]) {
      stub({ [name]: undefined })
      expect(billingConfig(), `${name} missing must disable billing`).toBeNull()
      vi.unstubAllEnvs()
    }
  })

  it('is null when any single value is blank', () => {
    for (const name of Object.keys(GOOD) as (keyof typeof GOOD)[]) {
      stub({ [name]: '   ' })
      expect(billingConfig(), `${name} blank must disable billing`).toBeNull()
      vi.unstubAllEnvs()
    }
  })

  /**
   * THE DECISION THAT NOTHING TAKES REAL MONEY IS ENFORCED HERE, NOT DOCUMENTED.
   *
   * CLAUDE.md says no real payments before the independent security review. A note can be
   * forgotten by whoever pastes a key into Vercel; this cannot. A live key disables billing
   * rather than enabling it, which fails in the direction that costs nobody anything.
   */
  it('refuses a live secret key outright', () => {
    stub({ STRIPE_SECRET_KEY: 'sk_live_realmoney' })
    expect(billingConfig()).toBeNull()
  })

  it('refuses a restricted or publishable key in the secret slot', () => {
    for (const key of ['rk_test_abc', 'pk_test_abc', 'sk_abc', 'whsec_abc']) {
      stub({ STRIPE_SECRET_KEY: key })
      expect(billingConfig(), `"${key}" is not a test secret key`).toBeNull()
      vi.unstubAllEnvs()
    }
  })

  /**
   * `vercel env pull` renders any variable typed Sensitive as this literal string while
   * still printing a success line and exiting 0. All four secrets here must be typed
   * Sensitive, so this is the value a developer is most likely to actually be holding after
   * a fresh clone. It already cost this project once on the Supabase values, where a
   * placeholder sailed past the loud-failure guard and surfaced as a network error much
   * later; here it would surface as a 401 from Stripe on the one screen where someone is
   * trying to pay.
   */
  it('refuses the vercel env pull placeholder in every slot', () => {
    for (const name of Object.keys(GOOD) as (keyof typeof GOOD)[]) {
      stub({ [name]: '[SENSITIVE]' })
      expect(billingConfig(), `${name} as [SENSITIVE] must disable billing`).toBeNull()
      vi.unstubAllEnvs()
    }
  })

  /**
   * The shape check standing in for rule 4. `postgresql://postgres.<ref>:…` is on Supabase
   * effectively a service-role credential, and it is the string sitting in the dashboard's
   * Connect panel that somebody would paste here in a hurry.
   */
  it('refuses a connection string for any role but billing_writer', () => {
    for (const url of [
      'postgresql://postgres.projectref:pw@host:6543/postgres',
      'postgresql://postgres:pw@host:5432/postgres',
      'postgres://billing_writer.projectref:pw@host:6543/postgres',
      // The near miss. A loose prefix check would take this as the real role.
      'postgresql://billing_writership:pw@host:6543/postgres',
      'postgresql://billing_writer_readonly:pw@host:6543/postgres',
    ]) {
      stub({ BILLING_DATABASE_URL: url })
      expect(billingConfig(), `"${url}" must not be accepted`).toBeNull()
      vi.unstubAllEnvs()
    }
  })

  /**
   * TWO POOLER CONVENTIONS SPELL THE USERNAME DIFFERENTLY, and this check used to know only
   * one of them. Supavisor's shared pooler puts the tenant in the username
   * (`billing_writer.<project-ref>`); Supabase's DEDICATED pooler uses the bare role. The
   * `billing_writer.` prefix was written against the first and would have rejected the only
   * correct string for a project on the second — silently, as "billing is not configured",
   * on a deployment where everything else was right.
   */
  it('accepts either pooler convention for the username', () => {
    for (const url of [
      'postgresql://billing_writer:pw@db.ref.supabase.co:6543/postgres',
      'postgresql://billing_writer.projectref:pw@aws-1-us-east-2.pooler.supabase.com:6543/postgres',
      'postgresql://billing_writer@db.ref.supabase.co:6543/postgres',
    ]) {
      stub({ BILLING_DATABASE_URL: url })
      expect(billingConfig(), `"${url}" must be accepted`).not.toBeNull()
      vi.unstubAllEnvs()
    }
  })

  /**
   * Two cards, one price id, no error anywhere: the yearly card would charge $8 a month or
   * the monthly card $72 a year, and Stripe would accept either without complaint. It is the
   * kind of paste error that looks right in a dashboard and is only visible on a statement.
   */
  it('refuses the same price id for both cadences', () => {
    stub({ STRIPE_PRICE_PRO_ANNUAL: GOOD.STRIPE_PRICE_PRO_MONTHLY })
    expect(billingConfig()).toBeNull()
  })

  it('tolerates surrounding whitespace, which is what a copy-paste leaves behind', () => {
    stub({ STRIPE_SECRET_KEY: `  ${GOOD.STRIPE_SECRET_KEY}\n` })
    expect(billingConfig()?.secretKey).toBe(GOOD.STRIPE_SECRET_KEY)
  })

  /**
   * FOUR OF THE SIX VALUES ARE SECRETS, so this function says nothing at all about which one
   * was wrong. A diagnostic naming the malformed variable is a diagnostic that eventually
   * prints a key into a log. The operator's tool for finding out is `pnpm billing:setup`,
   * which runs against their own terminal.
   */
  it('never throws and never returns a message that could carry a value', () => {
    stub({ STRIPE_SECRET_KEY: 'sk_live_supersecretvalue' })
    expect(() => billingConfig()).not.toThrow()
    expect(billingConfig()).toBeNull()
  })
})

describe('billingEnabled', () => {
  it('is off when the flag is unset, however complete the configuration', () => {
    stub({ CLOAKCAL_BILLING: undefined })
    expect(billingConfig()).not.toBeNull()
    expect(billingEnabled()).toBe(false)
  })

  it('is on only when the flag is exactly "1" AND the configuration is complete', () => {
    stub({ CLOAKCAL_BILLING: '1' })
    expect(billingEnabled()).toBe(true)
  })

  /**
   * The wrong way round would be a purchase button whose route cannot work — a failure that
   * surfaces at the click, on the one screen where a user is trying to give us money.
   */
  it('is off when the flag is set but a value is missing', () => {
    stub({ CLOAKCAL_BILLING: '1', STRIPE_WEBHOOK_SECRET: undefined })
    expect(billingEnabled()).toBe(false)
  })

  it('is off when the flag is set but the key is live', () => {
    stub({ CLOAKCAL_BILLING: '1', STRIPE_SECRET_KEY: 'sk_live_realmoney' })
    expect(billingEnabled()).toBe(false)
  })

  it('treats every other truthy-looking flag value as off', () => {
    for (const value of ['true', 'yes', 'on', '0', '', ' 1', '1 ']) {
      stub({ CLOAKCAL_BILLING: value })
      expect(billingEnabled(), `"${value}" must not enable billing`).toBe(false)
      vi.unstubAllEnvs()
    }
  })
})
