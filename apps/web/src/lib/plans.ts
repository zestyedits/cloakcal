/**
 * THE plan catalog — the tiers, their prices, and what each one actually includes.
 *
 * IT HAS TO LIVE HERE, for exactly the reason lib/settings-sections.ts states in full: a
 * server component that imports a plain value out of a `'use client'` module gets a
 * client-reference proxy rather than the value, and when that happens inside a Suspense
 * fallback it renders as a DOUBLED PAGE rather than as an error. Three modules read this
 * one, and `settings-screen.tsx` — a `'use client'` module — is among them, which is exactly
 * the shape that broke once already.
 *
 * WHAT IS ON EACH SIDE OF THE LINE, AND WHY.
 *
 * Free is everything CloakCal does today. That is not generosity, it is the architecture
 * doc's binding rule: "basic privacy is never paywalled. Paid plans sell power, scale,
 * professional workflows, integrations, automation, and customization, not the right to
 * keep an appointment private." Cloaking, visibility rules and View As are the whole
 * shipped product, so the whole shipped product is free.
 *
 * Pro therefore has an EMPTY `includes`, and that is the honest shape rather than an
 * oversight. Listing shipped features under Pro would be claiming free accounts do not have
 * them. Everything in `planned` is unbuilt and named as unbuilt.
 *
 * NO PUBLISHED LIMITS, anywhere in this file. Nothing in the product counts anything: there
 * is no calendar count, no contact count, no quota, and no place to enforce one, because the
 * browser holds a real PostgREST token and can insert straight into the tables. A limit
 * inside an RPC is decoration. So a number here would be a claim the eleventh calendar
 * sails past, which is the same failure as the sign-up screen that said "We sent a
 * confirmation link to X" when it had sent nothing. Limits get published the day they are
 * metered, and not before.
 *
 * See docs/decisions/0007-plan-and-billing.md.
 */

export type PlanId = 'free' | 'pro'

/**
 * Whether money can change hands for a tier TODAY.
 *
 * A union rather than a boolean, and `purchaseLabel` below is what makes that load-bearing
 * rather than decorative: it switches exhaustively, so adding `'available'` here is a
 * COMPILE ERROR at the one place a tier's purchase state is rendered. A boolean flipping
 * false to true would compile silently and ship a button that takes no payment.
 */
export type PlanPurchase = 'included' | 'coming-soon'

/**
 * The tag a tier wears. The `never` branch is the guarantee: it stops compiling the moment
 * a third purchase state exists, which is exactly when somebody needs to look at every
 * surface that renders one.
 */
export function purchaseLabel(purchase: PlanPurchase): string | null {
  switch (purchase) {
    case 'included':
      return null
    case 'coming-soon':
      return 'Coming soon'
    default: {
      const unhandled: never = purchase
      throw new Error(`unhandled purchase state: ${String(unhandled)}`)
    }
  }
}

export interface PlanPrice {
  /** Named, never assumed. A price with no currency in its type is how a $ ships as a £. */
  readonly currency: 'USD'
  /** Integer cents, never a float: 8.99 * 12 is not 107.88 in binary floating point. */
  readonly monthlyCents: number
  /**
   * The ANNUAL TOTAL, not a monthly equivalent. The per-month figure is derived at render
   * time; storing both is how the two come to disagree by a rounding step.
   */
  readonly annualCents: number
}

export interface PlanTier {
  readonly id: PlanId
  readonly name: string
  readonly tagline: string
  /**
   * Null for free. Not `{ monthlyCents: 0 }` — "there is no price" and "the price is zero"
   * render differently and only one of them is true.
   */
  readonly price: PlanPrice | null
  /** What this tier gives you in a build that exists. Nothing aspirational. */
  readonly includes: readonly string[]
  /** Named, and explicitly NOT included. Same grammar as the settings roadmap footer. */
  readonly planned: readonly { readonly name: string; readonly detail: string }[]
  readonly purchase: PlanPurchase
}

export const DEFAULT_PLAN_ID: PlanId = 'free'

export const PLANS: readonly PlanTier[] = [
  {
    id: 'free',
    name: 'Free',
    tagline: 'Everything CloakCal does today, for one person.',
    price: null,
    includes: [
      // The landing page's exact scope, deliberately. This used to read "Your events,
      // encrypted in this browser", which claims the EVENT is encrypted when times,
      // durations, repeats and calendar membership are stored in the clear (rule 1). It is
      // the first bullet on a pricing page, above the honesty paragraph and not travelling
      // with it in a screenshot, which is exactly the shape of overclaim that gets a
      // privacy product in trouble.
      'Titles, places, notes and guest lists, encrypted in this browser before they are stored',
      'Agenda, week, day and month views',
      'As many calendars as you want, named and coloured',
      // NOT "and for anyone with the link". There is no link: nothing can be sent to
      // anyone yet. The `public` audience is real in the engine and the settings control
      // honestly calls it "Anyone with the link" because it is a rule you are SETTING, but
      // the same words in a feature list read as a capability that works.
      'Visibility rules for each person and each group',
      'View As, to see your calendar the way someone else would',
      'Contacts and groups, whose names are encrypted too',
      'Repeating events that keep their wall time across a clock change',
      'Passkeys, a 24 word recovery phrase, and password changes',
    ],
    planned: [
      {
        name: 'Export',
        detail:
          'Take your calendar out as a standard .ics file, or the whole account as an archive. This stays free permanently: charging to leave is not something a privacy product gets to do.',
      },
    ],
    purchase: 'included',
  },
  {
    id: 'pro',
    name: 'Pro',
    tagline: 'For the work that happens around your calendar.',
    price: { currency: 'USD', monthlyCents: 800, annualCents: 7200 },
    // Empty on purpose. See the header: everything shipped is on Free by decision.
    includes: [],
    planned: [
      {
        name: 'Booking',
        detail: 'Let people book time with you without handing them your calendar.',
      },
      {
        name: 'Other calendars',
        detail:
          'Bring a Google or Apple calendar in, with CloakCal still deciding what anyone else sees.',
      },
      {
        name: 'Shared calendars',
        detail: 'A calendar more than one person can write to, with the rules still per person.',
      },
      {
        name: 'Automations',
        detail: 'Reminders and follow ups around a booking, on rules you write.',
      },
    ],
    purchase: 'coming-soon',
  },
]

export const isPlanId = (value: unknown): value is PlanId =>
  value === 'free' || value === 'pro'

export function planById(id: PlanId): PlanTier {
  const found = PLANS.find((plan) => plan.id === id)
  // Unreachable while PlanId and PLANS agree, which is the point of throwing rather than
  // falling back to Free: a silent fallback would hide a catalog that had lost a tier.
  if (found === undefined) throw new Error(`no such plan: ${id}`)
  return found
}

export type PlanCadence = 'monthly' | 'annual'

/** Whole dollars where the cents are zero, which is every price we intend to charge. */
export function formatPlanPrice(price: PlanPrice, cadence: PlanCadence): string {
  const cents = cadence === 'monthly' ? price.monthlyCents : price.annualCents
  const dollars = cents / 100
  const body = Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2)
  return price.currency === 'USD' ? `$${body}` : `${body} ${price.currency}`
}

/** What a year works out at per month, for the line that does the arithmetic for you. */
export function annualPerMonth(price: PlanPrice): string {
  return formatPlanPrice(
    { ...price, monthlyCents: Math.round(price.annualCents / 12) },
    'monthly',
  )
}

/** Rounded DOWN, so the page can never overstate the discount. */
export function annualSavingPercent(price: PlanPrice): number {
  const full = price.monthlyCents * 12
  if (full === 0) return 0
  return Math.floor(((full - price.annualCents) / full) * 100)
}

/** How many months of the year you are not paying for. Rounded down, same reason. */
export function annualMonthsFree(price: PlanPrice): number {
  if (price.monthlyCents === 0) return 0
  return Math.floor((price.monthlyCents * 12 - price.annualCents) / price.monthlyCents)
}
