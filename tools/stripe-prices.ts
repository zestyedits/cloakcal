import { type PlanCadence, type PlanTier } from '../apps/web/src/lib/plans.js'

/**
 * The pure half of `stripe-setup.ts`: what a price should BE, derived from the catalog.
 *
 * Its own module so the `tools` vitest project can assert it without a network, a key or a
 * Stripe account, exactly as `spf.ts` sits beside `email-setup.ts`. Everything in here is a
 * pure function of `PLANS`, which is the point: the price on the pricing page and the price
 * Stripe charges must come from one constant, and the way to guarantee that is for the
 * provisioning script to have no numbers of its own.
 */

/**
 * The stable handle for a price. `lookup_key` is the only identifier a Stripe Price accepts
 * from the caller, and it can be TRANSFERRED between prices, which is what makes a price
 * change survivable: a new price takes the key, the old one is archived, and the script's next
 * run finds the new one where it looked for the old.
 *
 * Currency is in the key because the day this product sells in a second currency, the two are
 * different prices with the same cadence and the key would otherwise collide silently.
 */
export function lookupKeyFor(planId: string, cadence: PlanCadence, currency: string): string {
  return `cloakcal_${planId}_${cadence}_${currency.toLowerCase()}`
}

export interface PriceParams {
  readonly currency: string
  readonly unit_amount: number
  readonly recurring: { readonly interval: 'month' | 'year' }
}

/**
 * A tier and a cadence to the parameters Stripe wants.
 *
 * IT THROWS ON A CURRENCY IT HAS NOT BEEN TAUGHT rather than lowercasing whatever it is
 * given. `plans.ts` types the currency as the literal `'USD'` precisely so a price cannot ship
 * as the wrong denomination, and a mapper that answers `{ currency: 'gbp' }` for a tier
 * somebody just changed would undo that at the one step where it becomes real money. Stripe
 * would accept it without complaint, and the first sign would be a bank statement.
 */
export function priceParamsFor(tier: PlanTier, cadence: PlanCadence): PriceParams {
  const price = tier.price
  if (price === null) throw new Error(`${tier.id} has no price and cannot be sold`)
  if (price.currency !== 'USD') {
    throw new Error(
      `priceParamsFor has not been taught ${String(price.currency)}. Add it deliberately: a ` +
        `currency mapped by accident is a charge in the wrong denomination that Stripe will ` +
        `accept without complaint.`,
    )
  }

  const amount = cadence === 'monthly' ? price.monthlyCents : price.annualCents
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`${tier.id} ${cadence} is ${amount}, which is not an amount of money`)
  }

  return {
    currency: 'usd',
    unit_amount: amount,
    recurring: { interval: cadence === 'monthly' ? 'month' : 'year' },
  }
}

/**
 * Whether an existing Stripe price still matches the catalog.
 *
 * A STRIPE PRICE AMOUNT IS IMMUTABLE, so "no" does not mean "update it" — it means create a
 * new price, transfer the lookup key, and archive the old one. `stripe-setup.ts` does that and
 * warns loudly if anyone is subscribed to the old price, because **archiving does not migrate
 * existing subscribers**: they keep paying the old amount, indefinitely, with nothing anywhere
 * saying so.
 *
 * That is the practical footnote to ADR 0007's "the price is one constant… moving inside the
 * band costs one edit". It costs one edit plus a price migration, and this is where that
 * becomes visible instead of surprising.
 */
export function needsNewPrice(
  existing: { unit_amount: number | null; currency: string; recurring: { interval: string } | null },
  desired: PriceParams,
): boolean {
  return (
    existing.unit_amount !== desired.unit_amount ||
    existing.currency !== desired.currency ||
    existing.recurring?.interval !== desired.recurring.interval
  )
}
