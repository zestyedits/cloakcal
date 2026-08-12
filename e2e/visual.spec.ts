import { expect, test } from '@playwright/test'

/**
 * Visual baselines at the two breakpoints the references specify.
 *
 * These catch layout regressions, not privacy ones — but a screenshot that suddenly shows
 * a placeholder where a title belongs (or the reverse) is exactly the kind of change worth
 * failing on, so the baselines are taken after decryption.
 */

const settle = async (page: import('@playwright/test').Page) => {
  await page.goto('/')
  await expect(page.getByText('Legal Call')).toBeVisible({ timeout: 15_000 })
  // Disable animation so the baseline is deterministic rather than timing-dependent.
  await page.emulateMedia({ reducedMotion: 'reduce' })
}

test('agenda view — desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await settle(page)
  await expect(page).toHaveScreenshot('agenda-desktop.png', { fullPage: true })
})

test('agenda view — mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await settle(page)
  await expect(page).toHaveScreenshot('agenda-mobile.png', { fullPage: true })
})

test('landing — desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  // Reduced motion BEFORE navigation: the demo's auto-advance timer never starts, so the
  // card sits deterministically on the server-rendered "You" state.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/?landing=1')
  await expect(page.getByText('Legal call, custody')).toBeVisible()
  await expect(page).toHaveScreenshot('landing-desktop.png', { fullPage: true })
})

test('landing — mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/?landing=1')
  await expect(page.getByText('Legal call, custody')).toBeVisible()
  await expect(page).toHaveScreenshot('landing-mobile.png', { fullPage: true })
})

test('agenda view — locked, before hydration', async ({ page }) => {
  // The privacy-relevant baseline: what a viewer sees before any key is available.
  await page.route('**/*.js', (route) => route.abort())
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  // domcontentloaded races the streamed Suspense content: without this wait the shot
  // sometimes catches the skeleton fallback instead of the sealed agenda, and a baseline
  // of the skeleton pins nothing privacy-relevant. The placeholder text is server
  // rendered and streams in with no .js fetch, so waiting on it stays valid here.
  await expect(page.getByText('Private event').first()).toBeVisible({ timeout: 15_000 })
  await expect(page).toHaveScreenshot('agenda-locked-mobile.png', { fullPage: true })
})
