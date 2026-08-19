import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PLAN_ID,
  PLANS,
  annualMonthsFree,
  annualPerMonth,
  annualSavingPercent,
  formatPlanPrice,
  isPlanId,
  planById,
} from '../src/lib/plans'

/**
 * The plan catalog, and the promises it is allowed to make.
 *
 * Most of this file is tripwires rather than coverage. A pricing page's failure mode is not
 * a crash — it is a sentence that quietly stops being true, which nothing notices until a
 * user acts on it. So: the arithmetic on the page is derived rather than typed, and pinned;
 * "nothing here can be bought" is asserted as a fact about the DATA rather than trusted to
 * the markup; and the moment somebody flips a tier to purchasable, a test says so.
 */

const free = planById('free')
const pro = planById('pro')

/**
 * Comments stripped, in the house style of `billing-boundary.server.test.ts`.
 *
 * NOT optional, and it was caught by the guard below failing on its first run: ProBand's own
 * doc comment explains that `formatPlanPrice` moved to the billing band, and a raw-source
 * scan matched those words and reported the price as still being rendered here. A sweep
 * satisfied — or in this case refused — by a sentence describing its own subject's absence
 * is a sweep measuring prose.
 *
 * LINE COMMENTS COME OFF FIRST, AND THE ORDER IS LOAD-BEARING. Blocks-first is the obvious
 * way round and it is wrong: a line comment mentioning a path opens a block the matcher then
 * closes at the next block terminator it finds, swallowing everything between. That is not
 * hypothetical — it ate 3,884 characters of `export-calendar.tsx` and made a sweep report a
 * feature missing while it sat four lines below the comment that hid it.
 */
const code = (source: string): string =>
  source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

const PLAN_SCREEN = code(
  readFileSync(
    fileURLToPath(new URL('../src/components/settings/plan-screen.tsx', import.meta.url)),
    'utf8',
  ),
)

describe('what the catalog may claim', () => {
  it('sells nothing, and says so in the data rather than only in the copy', () => {
    /*
     * THE tripwire. `PlanPurchase` is a union precisely so a third member ('available')
     * makes this fail rather than compile: enabling purchase must be a deliberate act that
     * walks somebody through every place a tier is rendered, not a boolean flipping true.
     *
     * PURCHASABILITY TURNED OUT NOT TO BE A CATALOG FACT, and this comment used to imply it
     * was. The plan for the billing work said `PlanPurchase` would gain `'available'`; it did
     * not, because `PLANS` is a static constant and cannot know whether THIS DEPLOYMENT has
     * six billing variables set. A catalog that claimed Pro was purchasable would be wrong on
     * every environment where it is not — which is all of them today, and would still be some
     * of them afterwards.
     *
     * So `purchase` stays a fact about the CATALOG ("we have not launched this tier"), and
     * `billingEnabled()` is the fact about the DEPLOYMENT. The screen branches on the second,
     * and `plan-screen.tsx` renders this field only in the billing-off branch — where "Coming
     * soon" is exactly right.
     */
    expect(PLANS.filter((tier) => tier.purchase === 'coming-soon').map((t) => t.id)).toEqual([
      'pro',
    ])
    expect(PLANS.filter((tier) => tier.purchase === 'included').map((t) => t.id)).toEqual(['free'])
  })

  /**
   * The catalog's "Coming soon" tag and a live purchase control must never be on screen
   * together, and the way that is guaranteed is structural: the tag lives inside `ProBand`,
   * which is told whether billing is off. Asserted against the source because no rendered
   * test can hold both branches at once.
   *
   * The prop is matched by SHAPE rather than by name. This asserted the exact string
   * `showPricing={billing === null}` and so failed on a rename that changed nothing it cares
   * about — a guard that fires on its own subject moving is a guard people learn to edit
   * without reading.
   */
  it('renders its purchase state only where billing is switched off', () => {
    // ProBand is what renders `purchaseLabel`, and it is told which branch it is in.
    expect(PLAN_SCREEN).toMatch(/purchaseLabel\(tier\.purchase\)/)
    expect(PLAN_SCREEN).toMatch(/<ProBand tier=\{pro\} \w+=\{billing === null\} \/>/)
  })

  /**
   * NO PRICE ON THE PLAN PAGE OUTSIDE THE BILLING BAND, which is the durable version of the
   * rule the test above only gestures at.
   *
   * `ProBand` used to draw $8 and $72 whenever `billing === null` — that is, the price was
   * rendered in exactly the state where nobody could pay it, and hidden in the state where
   * the billing band draws the same figures as pressable controls. A price for something
   * unbuyable does not create demand; it invites the reader to doubt everything else on the
   * page. The arithmetic still lives in `lib/plans.ts` and is still rendered, by
   * `billing-band.tsx`, where the cards are buttons.
   */
  it('quotes no price outside the band that can take the money', () => {
    const helpers = /formatPlanPrice|annualPerMonth|annualSavingPercent|annualMonthsFree/
    expect(PLAN_SCREEN).not.toMatch(helpers)
    // The control this is a claim ABOUT: the helpers exist and are used, one file over.
    const band = code(
      readFileSync(
        fileURLToPath(new URL('../src/components/settings/billing-band.tsx', import.meta.url)),
        'utf8',
      ),
    )
    expect(band).toMatch(helpers)
  })

  it('puts everything shipped on the free tier and nothing on Pro', () => {
    /*
     * The architecture doc's binding rule: "basic privacy is never paywalled". Everything
     * CloakCal does today is a privacy or calendar feature, so it is all free, and Pro's
     * `includes` is EMPTY — listing shipped features under Pro would be claiming free
     * accounts do not have them.
     */
    expect(free.includes.length).toBeGreaterThan(0)
    expect(pro.includes).toEqual([])
  })

  it('keeps export on the free tier, permanently', () => {
    /*
     * Charging to leave is not something a privacy product gets to do. If this ever moves, it
     * should move loudly. See ADR 0007.
     *
     * This used to look for "Export" among the PLANNED items, which was right while it was a
     * roadmap entry and became wrong the moment it shipped — a test that would have gone red
     * for the good reason. It asserts the durable claim now: export is described on Free,
     * under either heading, and appears nowhere in Pro.
     */
    const freeText = [...free.includes, ...free.planned.map((i) => `${i.name} ${i.detail}`)]
    expect(freeText.some((line) => /export/i.test(line))).toBe(true)

    const proText = [...pro.includes, ...pro.planned.map((i) => `${i.name} ${i.detail}`)]
    expect(proText.some((line) => /export/i.test(line))).toBe(false)
  })

  it('publishes no limit it cannot enforce', () => {
    /*
     * Nothing in the product counts anything, and there is nowhere to enforce a count: the
     * browser holds a real PostgREST token and can insert straight into the tables, so a
     * limit inside an RPC is decoration. A number on the page that the eleventh calendar
     * sails past is the same failure as the sign-up screen that claimed it had sent an email
     * it never sent. Limits ship the day they are metered.
     */
    const copy = PLANS.flatMap((tier) => [
      tier.tagline,
      ...tier.includes,
      ...tier.planned.map((item) => `${item.name} ${item.detail}`),
    ]).join(' ')
    expect(copy).not.toMatch(/\bup to \d|\b\d+ calendars\b|\bunlimited\b/iu)
  })

  it('never widens what is encrypted, and never promises a link', () => {
    /*
     * Rule 1, guarded at the source rather than only on the rendered page. The first bullet
     * used to read "Your events, encrypted in this browser", which claims the EVENT is
     * encrypted when times, durations, repeats and calendar membership are all stored in the
     * clear. It sits above the honesty paragraph and does not travel with it in a
     * screenshot, which is exactly how a privacy product ends up having overclaimed.
     *
     * And nothing may promise link sharing: `access_envelopes` is unused and nothing can be
     * sent to anyone. "Anyone with the link" is honest on a settings control, where it names
     * a rule you are setting; in a feature list it reads as a capability that works.
     */
    const copy = PLANS.flatMap((tier) => tier.includes).join(' ')
    expect(copy).not.toMatch(/\byour events,? encrypted|\bevents are encrypted/iu)
    expect(copy).not.toMatch(/anyone with the link/iu)
    expect(copy).not.toMatch(/zero.?knowledge|end.to.end/iu)
  })

  it('carries no em dash, by decree', () => {
    const copy = PLANS.flatMap((tier) => [
      tier.name,
      tier.tagline,
      ...tier.includes,
      ...tier.planned.flatMap((item) => [item.name, item.detail]),
    ]).join(' ')
    expect(copy).not.toContain('—')
  })
})

describe('the prices', () => {
  it('defaults to free, which is what an account with no subscription row gets', () => {
    expect(DEFAULT_PLAN_ID).toBe('free')
    expect(free.price).toBeNull()
    // Null, not `{ monthlyCents: 0 }`. "There is no price" and "the price is zero" render
    // differently and only one of them is true.
  })

  it('makes a year cheaper than twelve months, and says by how much', () => {
    const price = pro.price
    if (price === null) throw new Error('Pro has no price')

    expect(price.annualCents).toBeLessThan(price.monthlyCents * 12)
    expect(formatPlanPrice(price, 'monthly')).toBe('$8')
    expect(formatPlanPrice(price, 'annual')).toBe('$72')
    expect(annualPerMonth(price)).toBe('$6')
    expect(annualSavingPercent(price)).toBe(25)
    expect(annualMonthsFree(price)).toBe(3)
  })

  it('rounds a saving DOWN, so the page can never overstate it', () => {
    // 799 * 12 = 9588 against 7200 is 24.9%, which must read as 24 and not 25.
    const price = { currency: 'USD', monthlyCents: 799, annualCents: 7200 } as const
    expect(annualSavingPercent(price)).toBe(24)
  })

  it('formats cents when there are any, rather than dropping them', () => {
    const price = { currency: 'USD', monthlyCents: 850, annualCents: 9000 } as const
    expect(formatPlanPrice(price, 'monthly')).toBe('$8.50')
  })
})

describe('the guards', () => {
  it('recognises only the tiers that exist', () => {
    expect(isPlanId('free')).toBe(true)
    expect(isPlanId('pro')).toBe(true)
    for (const value of ['enterprise', '', null, undefined, 0, {}]) {
      expect(isPlanId(value)).toBe(false)
    }
  })

  it('throws on a tier the catalog has lost, rather than falling back to free', () => {
    // A silent fallback would hide a catalog that no longer matches PlanId. The database
    // clamps to free on a bad READ (server/plan.ts); this is a different failure — the
    // catalog itself being wrong — and it should be loud.
    // @ts-expect-error deliberately outside PlanId
    expect(() => planById('enterprise')).toThrow(/no such plan/u)
  })

  it('gives every tier a unique id', () => {
    expect(new Set(PLANS.map((tier) => tier.id)).size).toBe(PLANS.length)
  })
})
