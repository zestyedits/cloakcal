import { expect, test } from '@playwright/test'

/**
 * The landing page, reached through the fixture-gated `/?landing=1` door: every project
 * here runs in fixture mode, where `/` renders the demo calendar and the real
 * session-branch landing is otherwise reachable by no test. Production ignores the
 * param; the session decides there.
 *
 * The hero WEEK is the page's one interactive piece, so it gets the coverage: choosing a
 * person reseals the week, a manual choice cancels the auto-advance, and withheld events are
 * ABSENT from the DOM rather than hidden by CSS.
 *
 * The last one is the assertion worth having. "Hidden" in this product means the row is not
 * there at all, the way the dates under the cloak in the mark are missing rather than greyed
 * — a block dimmed to invisibility would still tell a reader that SOMETHING is scheduled,
 * which is the exact leak the whole product exists to close. A CSS-based hide would look
 * identical in a screenshot and be wrong.
 */

test('choosing a person reseals the whole week', async ({ page }) => {
  await page.goto('/?landing=1')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Not everything')

  // Server-rendered initial state: the owner's own view, everything readable.
  await expect(page.getByText('Discovery call, Novaline')).toBeVisible()
  await expect(page.getByText('Therapy')).toBeVisible()
  await expect(page.getByText('Lunch with Sam')).toBeVisible()

  const priya = page.getByRole('button', { name: /Priya/ })
  await priya.click()
  await expect(priya).toHaveAttribute('aria-pressed', 'true')

  // Her OWN meetings stay in full. A demo where every audience simply sees less would be a
  // brightness slider; the point is that the rules are per person.
  await expect(page.getByText('Discovery call, Novaline')).toBeVisible()
  await expect(page.getByText('Novaline, contract')).toBeVisible()

  // The private ones are gone from the DOM entirely, not dimmed.
  await expect(page.getByText('Therapy')).toHaveCount(0)
  await expect(page.getByText('Lunch with Sam')).toHaveCount(0)
  await expect(page.getByText('Dr. Okafor')).toHaveCount(0)

  await page.getByRole('button', { name: 'Everyone else' }).click()
  // A wall of Busy and nothing else. No title from any calendar survives.
  await expect(page.getByText('Busy').first()).toBeVisible()
  for (const title of ['Discovery call, Novaline', 'Novaline, contract', 'Therapy', 'Team standup']) {
    await expect(page.getByText(title)).toHaveCount(0)
  }
})

test('the grid never moves, whoever is looking', async ({ page }) => {
  await page.goto('/?landing=1')

  // THE test on this page. The hero's whole argument is that times, durations and repeats
  // stay readable to everyone while content does not, so a block that moved or resized when
  // the audience changed would be drawing a claim the product does not make.
  const box = async () => {
    const el = page.locator('[class*="landing-calendar_column"]').first()
    const rect = await el.boundingBox()
    return { w: Math.round(rect?.width ?? 0), h: Math.round(rect?.height ?? 0) }
  }
  const before = await box()

  for (const person of ['Priya', 'Marcus', 'Everyone else', 'You']) {
    await page.getByRole('button', { name: new RegExp(person) }).click()
    expect(await box()).toEqual(before)
  }

  // The hour gutter is the other half of the same promise: same labels, every state.
  await expect(page.getByText('noon', { exact: true })).toBeVisible()
})

test('choosing a person cancels the auto-advance', async ({ page }) => {
  await page.goto('/?landing=1')
  const chosen = page.getByRole('button', { name: 'Everyone else' })
  await chosen.click()
  await expect(chosen).toHaveAttribute('aria-pressed', 'true')
  // Longer than one auto-advance hold (HOLD_MS is 3800): if the timer were still running,
  // the week would have moved on to another person by now. WCAG 2.2.2 - the buttons are the
  // manual control, and a manual choice has to stick.
  await page.waitForTimeout(4200)
  await expect(chosen).toHaveAttribute('aria-pressed', 'true')
})

test('the page says it is not open, and offers no action that is not', async ({ page }) => {
  await page.goto('/?landing=1')

  await expect(page.getByText('Coming soon')).toBeVisible()
  await expect(page.getByText('New accounts open soon.')).toBeVisible()

  // The whole point: no control anywhere that promises an account. If sign-ups reopen,
  // this assertion is the one that should fail and make someone revisit the copy.
  await expect(page.getByRole('link', { name: 'Create your calendar' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Get started' })).toHaveCount(0)

  // Sign in survives, because Keith still has to get in. EXACTLY ONE of them: the header
  // and the hero both used to render it, so the page asked twice for the one thing a
  // visitor cannot do yet. The count is the assertion, not the presence.
  const signIn = page.getByRole('link', { name: 'Sign in' })
  await expect(signIn).toHaveCount(1)
  await expect(signIn).toHaveAttribute('href', '/sign-in')

  // The audience picker is what the hero offers instead, so it has to be reachable as a
  // real control rather than as decoration inside the demo.
  await expect(page.getByRole('group', { name: 'Show the week as' })).toBeVisible()
})

test('no em dash anywhere in the rendered page', async ({ page }) => {
  // Keith's decree, pinned by a test rather than by review: copy uses commas, colons and
  // periods. The en dash in date ranges is typography, not prose, and is not this
  // character.
  await page.goto('/?landing=1')
  expect(await page.content()).not.toContain('—')
})

test('the calendar and settings pages carry no em dash either', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('Legal Call')).toBeVisible({ timeout: 15_000 })
  expect(await page.content()).not.toContain('—')

  /*
   * EVERY settings route, not just the hub. The hub is four links; all the copy this sweep
   * used to cover moved onto its children, so checking `/settings` alone would have kept
   * passing while checking almost nothing.
   */
  for (const path of [
    '/settings',
    '/settings/privacy',
    '/settings/calendar',
    '/settings/security',
  ]) {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    expect(await page.content(), path).not.toContain('—')
  }
})

test('no horizontal scroll on a phone', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the desktop project has no narrow viewport to overflow')
  await page.goto('/?landing=1')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
})
