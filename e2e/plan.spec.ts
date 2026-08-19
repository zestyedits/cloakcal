import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

/**
 * /settings/plan — the tier you are on, what Pro will cost, and the plain statement that Pro
 * cannot be bought yet.
 *
 * The load-bearing tests here are the NEGATIVE ones. Anyone can see a price render; the
 * thing this page has to keep being is honest, so the suite pins that no purchase control
 * exists, that the demo does not claim an account, and that the privacy promise is not
 * quietly moved behind the paywall by a later copy edit.
 *
 * This file must be named in BOTH testMatch allowlists in playwright.config.ts. A spec named
 * in one is collected by half the projects and reports as full coverage;
 * apps/web/test/e2e-registration.server.test.ts now fails if the two ever disagree.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/settings/plan')
  await expect(page.getByRole('heading', { level: 1, name: 'Plan' })).toBeVisible()
})

test('settings offers no door to it while nothing can be bought', async ({ page }) => {
  /*
   * THE PAGE STAYS REACHABLE AND STOPS BEING ADVERTISED, which is the whole of the gate.
   *
   * Stripe's success_url, cancel_url and return_url all point here, so deleting the route was
   * never an option; what was wrong was putting a tier row in Settings for somebody who has
   * nothing to decide. `settings-sections.ts` marks this door `gate: 'billing'` and the hub
   * resolves it through `visibleDoors(billingEnabled())`, which is false everywhere today.
   */
  await page.goto('/settings')
  await expect(page.getByRole('heading', { level: 2, name: 'Billing' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Billing', exact: true })).toHaveCount(0)

  // Still there, still honest, for anybody who types it or arrives back from a processor.
  await page.goto('/settings/plan')
  await expect(page.getByRole('heading', { level: 1, name: 'Plan' })).toBeVisible()
})

test('renders under the demo without inventing an account', async ({ page }) => {
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
  await expect(page.getByText(/There is no account here, so there is no plan on file/)).toBeVisible()
  /*
   * The fixture has no account, so NOTHING may tell it which plan it is on — not the
   * sentence and not the badge. Both halves matter: the badge said "Free" directly above the
   * note saying there is no plan on file, which is one surface contradicting another in the
   * same view, and only the sentence was asserted.
   */
  await expect(page.getByText(/You are on/)).toHaveCount(0)
  // The BADGE, by its data attribute rather than its text: getByText defaults to a
  // case-insensitive substring match, so "Free plan" also matches the closing sentence
  // "cloaking an event stays on the free plan", which is copy this page should keep.
  await expect(page.locator('[data-plan]')).toHaveCount(0)
})

/**
 * THE ASSERTION THAT ACTUALLY PROTECTS AGAINST THE FLAG BEING ON BY ACCIDENT.
 *
 * The name-regex sweep below is a good guard and it is guessing: it protects against a button
 * called "Upgrade" and not against one called "Continue to Stripe", which is what the billing
 * band deliberately calls its own. This one does not depend on knowing the copy. The band
 * renders `[data-billing]` and nothing else does, so its absence IS "billing is switched off",
 * which is the state every deployment and every Playwright project is in.
 *
 * Two guards, deliberately, and they fail for different reasons: this one catches the flag
 * being on, the regex catches somebody hand-wiring a purchase control outside the band.
 */
test('renders no billing band at all while billing is switched off', async ({ page }) => {
  await expect(page.locator('[data-billing]')).toHaveCount(0)
  await expect(page.getByText(/Billing is in test mode/)).toHaveCount(0)
  await expect(page.getByText(/Billing preview/)).toHaveCount(0)
})

test('quotes no price for something nobody can buy', async ({ page }) => {
  /*
   * INVERTED, and the old assertion was the defect rather than the guard.
   *
   * `ProBand` drew $8 and $72 whenever `billing === null` — that is, the price appeared in
   * exactly the state where nobody could pay it, and vanished in the state where the billing
   * band draws the same figures as pressable controls. A number nobody can act on is not
   * information; it invites the reader to doubt the rest of the page. The arithmetic still
   * lives in lib/plans.ts and is still rendered, by billing-band.tsx, where the cards are
   * buttons — which `plan-catalog.server.test.ts` pins from the source side.
   */
  const body = (await page.locator('main').textContent()) ?? ''
  expect(body).not.toContain('$8')
  expect(body).not.toContain('$72')
  expect(body).not.toMatch(/a month|a year/)

  // The honest half survives: the tier is named, and the page says plainly it is not for sale.
  await expect(page.getByRole('heading', { level: 2, name: 'Pro' })).toBeVisible()
  await expect(page.getByText(/cannot be bought yet/).first()).toBeVisible()
  await expect(page.getByText(/Billing opens when sign-ups do/)).toBeVisible()

  /*
   * THE assertion on this page. It fails the day somebody wires a purchase button in
   * without wiring a payment processor behind it, which is the one failure this surface
   * exists to prevent: a page that takes a click and does nothing is worse than a page that
   * says it is not ready.
   */
  await expect(
    page.getByRole('button', { name: /upgrade|subscribe|buy|checkout|trial|pay/i }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('link', { name: /upgrade|subscribe|buy|checkout|trial|pay/i }),
  ).toHaveCount(0)
})

test('the only billing control is disabled and says why', async ({ page }) => {
  // Rendered rather than omitted, per the passkeys precedent: it gives the axe scan and the
  // 44px sweep something real to measure, and it answers "where do I cancel" on screen.
  await expect(page.getByRole('button', { name: 'Manage billing' })).toBeDisabled()
  await expect(page.getByText(/no card on file/)).toBeVisible()
})

/**
 * THE BILLING HEADING IS ALWAYS THERE, AND ALWAYS IN THE SAME PLACE.
 *
 * It used to be a row at the foot of "Your plan" while the flag was off and a band of its own
 * once it was on, so the answer to "where do I manage my subscription" moved depending on a
 * server flag no reader can see. Pinning the ORDER rather than mere presence is what catches a
 * later edit that keeps the heading and drops it below Pro, where a subscriber would have to
 * scroll past a pitch for the thing they already pay for to find the cancel button.
 */
test('files Billing between Your plan and Pro, whichever way the flag falls', async ({
  page,
}) => {
  const headings = await page
    .locator('main h2')
    .evaluateAll((nodes) => nodes.map((n) => (n.textContent ?? '').trim()))
  expect(headings).toEqual(['Your plan', 'Billing', 'Pro'])
})

/**
 * The caveat is stated ONCE. Five copies of "you cannot buy this yet" is not five times as
 * honest; it is a wall a reader skips, which is how a page ends up with an unread warning on
 * it. Counted rather than eyeballed, because the failure mode is additive — every future copy
 * edit that wants to be careful adds a sixth.
 */
test('says Pro is not for sale once, not five times', async ({ page }) => {
  const body = (await page.locator('main').textContent()) ?? ''
  const count = (pattern: RegExp) => body.match(pattern)?.length ?? 0

  // The sentence itself, and the two paraphrases that used to sit beside it.
  expect(count(/cannot be bought/g)).toBe(1)
  expect(count(/nothing (on this page will take a payment|can be bought)/g)).toBe(0)
  expect(count(/before billing opens/g)).toBeLessThanOrEqual(1)

  /*
   * The tag, twice: once beside the Pro heading, once on Free's Export row. It was SIX —
   * those two plus one on each of Pro's four roadmap rows, which sit under a heading reading
   * "What Pro will add" and above a note reading "None of these exist yet". A badge printed
   * six times on one screen is a badge nobody reads, including the one on Export, which is
   * the only place it carries information: that row is the single deferred item in a list of
   * eight shipped ones and without the tag it reads as a ninth feature.
   */
  expect(count(/Coming soon/g)).toBe(2)
})

test('makes no comparison between two things it is not selling', async ({ page }) => {
  /*
   * The other half of the price removal. "Better value" and "three months free" are claims
   * about a CHOICE between two cadences, and there is no choice on offer here — the cadence
   * cards that do offer one live in the billing band, where each is a radio you can press.
   * This asserted all three strings were visible; it now asserts the comparison is not made
   * anywhere a reader cannot act on it.
   */
  await expect(page.getByText('Better value')).toHaveCount(0)
  await expect(page.getByText(/months free/)).toHaveCount(0)
  await expect(page.getByText(/works out at/)).toHaveCount(0)
})

test('describes what is encrypted without widening it', async ({ page }) => {
  /*
   * The feature bullets, not just the honesty paragraph. This is the first thing on the
   * page and it is what a screenshot captures; the paragraph two blocks down does not
   * travel with it. It used to read "Your events, encrypted in this browser", which claims
   * the EVENT is encrypted when times, durations, repeats and calendar membership are all
   * stored in the clear.
   */
  await expect(
    page.getByText(/Titles, places, notes and guest lists, encrypted in this browser/),
  ).toBeVisible()
  await expect(page.getByText(/Your events, encrypted/)).toHaveCount(0)

  // And no bullet may promise link sharing, because nothing can be sent to anyone yet.
  await expect(page.getByText(/anyone with the link/)).toHaveCount(0)
})

test('does not move privacy behind the paywall', async ({ page }) => {
  await expect(page.getByText(/Basic privacy is never paywalled/)).toBeVisible()
  await expect(page.getByText(/Cloaking is not a paid feature/)).toBeVisible()

  // Rule 1. "zero knowledge" may appear ONLY in the sentence that denies it, and the
  // hyphenated spelling is the one a marketing edit reaches for, so it is forbidden
  // outright.
  await expect(page.getByText(/CloakCal is not zero knowledge/)).toBeVisible()
  expect(await page.content()).not.toContain('zero-knowledge')
})

test('carries no em dash', async ({ page }) => {
  // landing.spec.ts pins this for /, the calendar and /settings, and does not visit here.
  expect(await page.content()).not.toContain('—')
})

test('never scrolls sideways at 390px', async ({ page }) => {
  // An explicit width, so the number is pinned rather than inherited from whichever device
  // profile runs this. The price cards are the risk: a grid item defaults to a
  // content-based min-width, and nothing else in this suite would see the overflow.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'Plan' })).toBeVisible()

  const { client, scroll } = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }))
  expect(scroll).toBeLessThanOrEqual(client + 1)
})

test('has no detectable WCAG A or AA violations', async ({ page }) => {
  // Wait on the animations, never sleep: axe measures COMPOSITED colour, and analysing a
  // band mid-rise reports every label as a contrast failure against a box not yet painted.
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])
})

test('scans clean in the light theme too', async ({ page }) => {
  /*
   * The first axe run in this repo against a non-default theme, and it is here because this
   * page is where it would bite: --text-tertiary composited in the LIGHT theme measures
   * about 3.3:1 on every ground, which is under AA for body copy, and every other axe scan
   * runs in dark where the same ink passes comfortably. This page's roadmap rows take
   * secondary ink for exactly that reason, and this test is what keeps them there.
   */
  await page.getByRole('button', { name: 'Switch to light mode' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])
})

test('gives every interactive control a 44px touch target', async ({ page }) => {
  const measured = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button, a[href]')).map((el) => ({
      label: (el.textContent ?? '').trim().slice(0, 30) || el.tagName,
      height: Math.round(el.getBoundingClientRect().height),
      hidden: el.getBoundingClientRect().height === 0,
    })),
  )
  expect(measured.length).toBeGreaterThan(0)
  const tooSmall = measured
    .filter((m) => !m.hidden)
    .filter((m) => m.height < 44)
    .map((m) => `${m.label}: ${m.height}px`)
  expect(tooSmall).toEqual([])
})

test('keeps every heading in a sensible order', async ({ page }) => {
  const levels = await page.evaluate(() =>
    Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) =>
      Number(h.tagName.slice(1)),
    ),
  )
  expect(levels.length).toBeGreaterThan(0)
  for (let i = 1; i < levels.length; i += 1) {
    expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(1)
  }
})
