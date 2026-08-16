import type { BillingState, BillingView } from './view'

/**
 * ONE FABRICATED BillingView PER STATE, SERVED ONLY BEHIND `?billing=` IN THE DEV FIXTURE.
 *
 * THIS IS THE ONLY WAY THE BILLING CONTROLS EVER MEET AXE, and that is the whole reason the
 * file exists rather than a convenience for clicking around.
 *
 * `CLOAKCAL_BILLING` is a real environment variable and `playwright.config.ts` runs ONE dev
 * server, so switching it on for a billing spec switches it on for `plan.spec.ts` and reds
 * that file's purchase-control assertions. And it would buy nothing anyway: the demo has no
 * account, so a real flag-on fixture server renders exactly the page a flag-off one does.
 *
 * Without this, the cadence radios, the fact rows, the cancel confirmation and the invoice
 * list are measured by nothing — not the axe scan in either theme, not the 44px sweep, not the
 * 390px sideways-scroll guard. CLAUDE.md's "a control behind a click is a control nobody
 * tested" one level up: here the control is behind an ENVIRONMENT, which is worse, because
 * there is no click anyone could add to reach it.
 *
 * IT CANNOT REACH PRODUCTION. Its one caller gates on `isDevFixtureEnabled()` —
 * `NODE_ENV !== 'production'` AND an explicit flag — and Next inlines NODE_ENV at build time,
 * so a production bundle cannot take that branch. Same gate as the fixture calendar and the
 * published seed key, deliberately not a fourth one.
 *
 * NOTHING HERE IS A PLAN. `server/plan.ts` returns Free under the fixture and keeps doing so;
 * these are display facts for a screen, and the demo's entitlement is unchanged. ADR 0007 is
 * explicit that the demo must never hold a plan, and a preview that granted one would be the
 * pattern whoever wires the real thing copies.
 *
 * DATES ARE FIXED STRINGS, never computed from the clock. A snapshot or an axe run that
 * changes its own input every day is a test that fails on a Tuesday for no reason, and this
 * repo already pins `FIXTURE_NOW` for exactly that.
 */

const BASE: BillingView = {
  state: 'none',
  plan: 'free',
  cadence: null,
  renewsOn: null,
  cancelAtPeriodEnd: false,
  subscriptionId: null,
  cardSummary: null,
  invoices: [],
  stale: false,
  mode: 'test',
}

const INVOICES = [
  { id: 'in_3', date: '3 February 2026', amount: '$8', paid: true, url: null },
  { id: 'in_2', date: '3 January 2026', amount: '$8', paid: true, url: null },
  { id: 'in_1', date: '3 December 2025', amount: '$8', paid: true, url: null },
]

/**
 * `url: null` on every invoice above, deliberately. A real `hosted_invoice_url` is a
 * long-lived link to a Stripe page carrying an amount and an email address; committing
 * plausible ones into a fixture is how a demo link ends up in a screenshot. The band already
 * renders the row without a link, so the layout under test is the honest one.
 */
export const FIXTURE_BILLING: Record<BillingState, BillingView> = {
  none: BASE,

  lapsed: {
    ...BASE,
    state: 'lapsed',
    renewsOn: '3 March 2026',
  },

  granted: {
    ...BASE,
    state: 'granted',
    plan: 'pro',
  },

  active: {
    ...BASE,
    state: 'active',
    plan: 'pro',
    cadence: 'monthly',
    renewsOn: '3 March 2026',
    subscriptionId: 'sub_preview',
    cardSummary: 'Visa ending 4242',
    invoices: INVOICES,
  },

  cancelling: {
    ...BASE,
    state: 'cancelling',
    plan: 'pro',
    cadence: 'monthly',
    renewsOn: '3 March 2026',
    cancelAtPeriodEnd: true,
    subscriptionId: 'sub_preview',
    cardSummary: 'Visa ending 4242',
    invoices: INVOICES,
  },

  past_due: {
    ...BASE,
    state: 'past_due',
    plan: 'pro',
    cadence: 'annual',
    renewsOn: '3 March 2026',
    subscriptionId: 'sub_preview',
    // Null on purpose, so one preview state exercises the "On file at Stripe" fallback the
    // band draws when Stripe gave us a payment method it could not summarise.
    cardSummary: null,
    invoices: INVOICES,
  },

  /*
   * `stale: false`, which looks wrong and is not. `stale` means "Stripe was unreachable, so
   * these came from our columns"; `unreadable` means our OWN read failed, so there are no
   * columns to have fallen back to and nothing to warn about being a few minutes behind.
   * Setting both would put two different apologies on one screen.
   */
  unreadable: {
    ...BASE,
    state: 'unreadable',
  },
}

export const isBillingState = (value: unknown): value is BillingState =>
  typeof value === 'string' && Object.hasOwn(FIXTURE_BILLING, value)

/** Every state, for a spec that wants to walk them without restating the list. */
export const FIXTURE_BILLING_STATES = Object.keys(FIXTURE_BILLING) as readonly BillingState[]
