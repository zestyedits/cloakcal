import { describe, expect, it } from 'vitest'
import { planById, type PlanTier } from '../apps/web/src/lib/plans.js'
import { lookupKeyFor, needsNewPrice, priceParamsFor } from './stripe-prices.js'

/**
 * The pure half of `pnpm billing:setup`, asserted without a network or a Stripe account.
 *
 * These are the only tests in the repo that check the number a card is actually charged
 * against the number the pricing page prints, and they can only do that because the
 * provisioning script has no numbers of its own. If a literal amount ever appears in
 * `stripe-setup.ts`, this file stops being able to see it.
 */

const PRO = planById('pro')

describe('priceParamsFor', () => {
  it('charges exactly what lib/plans.ts publishes', () => {
    expect(priceParamsFor(PRO, 'monthly')).toEqual({
      currency: 'usd',
      unit_amount: 800,
      recurring: { interval: 'month' },
    })
    expect(priceParamsFor(PRO, 'annual')).toEqual({
      currency: 'usd',
      unit_amount: 7200,
      recurring: { interval: 'year' },
    })
  })

  it('reads the catalog rather than a copy of it', () => {
    // Not 800 and 7200 written again: the point is that the two agree, so both sides of the
    // comparison have to come from the same place the script reads.
    expect(priceParamsFor(PRO, 'monthly').unit_amount).toBe(PRO.price?.monthlyCents)
    expect(priceParamsFor(PRO, 'annual').unit_amount).toBe(PRO.price?.annualCents)
  })

  /**
   * `plans.ts` types the currency as the literal 'USD' precisely so a price cannot ship in the
   * wrong denomination. A mapper that lowercased whatever it was handed would undo that at the
   * one step where it becomes real money, and Stripe would accept `gbp` without complaint —
   * the first sign being a bank statement.
   */
  it('refuses a currency it has not been taught', () => {
    const gbp = { ...PRO, price: { ...PRO.price!, currency: 'GBP' } } as unknown as PlanTier
    expect(() => priceParamsFor(gbp, 'monthly')).toThrow(/has not been taught/)
  })

  it('refuses a tier with no price at all', () => {
    expect(() => priceParamsFor(planById('free'), 'monthly')).toThrow(/cannot be sold/)
  })

  it('refuses an amount that is not an amount of money', () => {
    for (const cents of [0, -800, 8.5, Number.NaN]) {
      const broken = { ...PRO, price: { ...PRO.price!, monthlyCents: cents } } as PlanTier
      expect(() => priceParamsFor(broken, 'monthly'), String(cents)).toThrow(
        /not an amount of money/,
      )
    }
  })
})

describe('lookupKeyFor', () => {
  it('is stable, so a later run finds what an earlier one made', () => {
    expect(lookupKeyFor('pro', 'monthly', 'usd')).toBe('cloakcal_pro_monthly_usd')
    expect(lookupKeyFor('pro', 'annual', 'USD')).toBe('cloakcal_pro_annual_usd')
  })

  it('keeps the two cadences apart', () => {
    expect(lookupKeyFor('pro', 'monthly', 'usd')).not.toBe(lookupKeyFor('pro', 'annual', 'usd'))
  })

  /**
   * Currency is in the key because the day this sells in a second one, monthly-USD and
   * monthly-GBP are different prices at the same cadence, and a key without it would have
   * them silently overwrite each other through `transfer_lookup_key`.
   */
  it('keeps two currencies apart', () => {
    expect(lookupKeyFor('pro', 'monthly', 'usd')).not.toBe(lookupKeyFor('pro', 'monthly', 'eur'))
  })
})

describe('needsNewPrice', () => {
  const desired = priceParamsFor(PRO, 'monthly')
  const matching = { unit_amount: 800, currency: 'usd', recurring: { interval: 'month' } }

  it('leaves a matching price alone', () => {
    expect(needsNewPrice(matching, desired)).toBe(false)
  })

  /**
   * A Stripe price amount is IMMUTABLE, so true here means "create a new one, transfer the
   * lookup key, archive the old" — and the script warns loudly if anyone is subscribed,
   * because archiving does not migrate them. They keep paying the old amount indefinitely,
   * with nothing anywhere saying so. That is the footnote to ADR 0007's "the price is one
   * constant, moving it costs one edit": it costs one edit plus a price migration.
   */
  it('notices a changed amount', () => {
    expect(needsNewPrice({ ...matching, unit_amount: 900 }, desired)).toBe(true)
  })

  it('notices a changed interval', () => {
    expect(needsNewPrice({ ...matching, recurring: { interval: 'year' } }, desired)).toBe(true)
  })

  it('notices a changed currency', () => {
    expect(needsNewPrice({ ...matching, currency: 'gbp' }, desired)).toBe(true)
  })

  it('notices a price that has lost its recurrence entirely', () => {
    // A one-off price where a subscription price belongs would be accepted by
    // `prices.list` and would fail at checkout, on the screen where somebody is paying.
    expect(needsNewPrice({ ...matching, recurring: null }, desired)).toBe(true)
    expect(needsNewPrice({ ...matching, unit_amount: null }, desired)).toBe(true)
  })
})
