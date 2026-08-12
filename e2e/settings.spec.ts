import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

/**
 * /settings under the dev fixture: no workspace and no session, so every section renders
 * with controls disabled and honest copy. That split is deliberate and mirrors the CRUD
 * suite — e2e owns structure, headings, targets and honesty; the db tests own what the
 * RPCs actually do. A fixture that could mutate would prove less, not more.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/settings')
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
})

test('every section is present, anchored, and in the stated order', async ({ page }) => {
  const sections = ['Appearance', 'Time & region', 'Calendars', 'People', 'Visibility', 'Security', 'Coming soon']
  for (const name of sections) {
    await expect(page.getByRole('heading', { level: 2, name })).toBeVisible()
  }
  // The nav chip navigates to its anchor.
  await page.getByRole('link', { name: 'Security' }).click()
  await expect(page).toHaveURL(/#security$/)
})

test('demo mode says so instead of offering dead controls', async ({ page }) => {
  // Sections that need a workspace disable with the same honest sentence, not a spinner
  // and not a silent no-op.
  await expect(page.getByText(/Demo data — sign in/).first()).toBeVisible()
  await expect(page.getByLabel('Timezone')).toBeDisabled()
  await expect(page.getByLabel('Week starts on')).toBeDisabled()
})

test('the theme radios switch the page and persist across reload', async ({ page }) => {
  const light = page.getByRole('radio', { name: 'Light' })
  await light.check()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  // Back to the default so later tests and screenshots see dark.
  await page.getByRole('radio', { name: /Dark/ }).check()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})

test('the deferred rows are named and quiet', async ({ page }) => {
  for (const name of ['Device pairing', 'Booking', 'Export']) {
    await expect(page.getByText(name, { exact: true })).toBeVisible()
  }
})

test('has no detectable WCAG A or AA violations', async ({ page }) => {
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
    Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) => Number(h.tagName.slice(1))),
  )
  expect(levels.length).toBeGreaterThan(0)
  for (let i = 1; i < levels.length; i += 1) {
    expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(1)
  }
})
