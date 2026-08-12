import { expect, test } from '@playwright/test'

/**
 * The landing page, reached through the fixture-gated `/?landing=1` door: every project
 * here runs in fixture mode, where `/` renders the demo calendar and the real
 * session-branch landing is otherwise reachable by no test. Production ignores the
 * param; the session decides there.
 *
 * The hero demo is the page's one interactive piece, so it gets the coverage: audience
 * tabs re-render the card, a manual choice cancels the auto-advance, and the withheld
 * fields are ABSENT from the DOM in the redacted states, not hidden by CSS.
 */

test('the audience tabs re-render the demo card', async ({ page }) => {
  await page.goto('/?landing=1')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Not everything')

  // Server-rendered initial state: the owner's view, everything readable.
  await expect(page.getByText('Legal call, custody')).toBeVisible()
  await expect(page.getByText('Conference Rm B')).toBeVisible()

  const clientTab = page.getByRole('button', { name: 'Your client' })
  await clientTab.click()
  await expect(clientTab).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('Legal call', { exact: true })).toBeVisible()
  // Limited hides the location and the sensitive half of the title, as absence.
  await expect(page.getByText('Legal call, custody')).toHaveCount(0)
  await expect(page.getByText('Conference Rm B')).toHaveCount(0)

  await page.getByRole('button', { name: 'Everyone else' }).click()
  // "Busy" appears twice on purpose: the redacted title AND the chip's label. Two, not
  // one, is the assertion — it pins that the title really did collapse to the level name.
  await expect(page.getByText('Busy', { exact: true })).toHaveCount(2)
  await expect(page.getByText('Legal call')).toHaveCount(0)
})

test('the time never changes, whoever is looking', async ({ page }) => {
  await page.goto('/?landing=1')
  const time = page.getByText('2:00 PM')
  await expect(time).toBeVisible()
  // exact: true, because Playwright's name option is a substring match and "You" is a
  // prefix of "Your client".
  for (const tab of ['Your client', 'Everyone else', 'You']) {
    await page.getByRole('button', { name: tab, exact: true }).click()
    await expect(time).toBeVisible()
    await expect(page.getByText('2:00 PM')).toHaveCount(1)
  }
})

test('choosing a tab cancels the auto-advance', async ({ page }) => {
  await page.goto('/?landing=1')
  await page.getByRole('button', { name: 'Everyone else' }).click()
  await expect(page.getByText('Busy', { exact: true }).first()).toBeVisible()
  // Longer than one auto-advance hold: if the timer were still running, the card would
  // have moved on from "Busy" by now.
  await page.waitForTimeout(3600)
  await expect(page.getByText('Busy', { exact: true }).first()).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Everyone else' }),
  ).toHaveAttribute('aria-pressed', 'true')
})

test('the CTAs lead to sign-up and sign-in', async ({ page }) => {
  await page.goto('/?landing=1')
  await expect(
    page.getByRole('link', { name: 'Create your calendar' }).first(),
  ).toHaveAttribute('href', '/sign-up')
  await expect(page.getByRole('link', { name: 'Sign in' }).first()).toHaveAttribute(
    'href',
    '/sign-in',
  )
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

  await page.goto('/settings')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  expect(await page.content()).not.toContain('—')
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
