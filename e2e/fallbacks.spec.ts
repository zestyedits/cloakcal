import { expect, test } from '@playwright/test'

/**
 * The fallback layer: surfaces that only exist when something has gone wrong, which is
 * exactly why they need their own spec — the delete-confirmation contrast failure
 * survived because axe only sees what is on screen, and nothing ever put these on screen.
 */

test('going offline shows the banner, coming back removes it', async ({ page, context }) => {
  await page.goto('/')
  await expect(page.getByText('Legal Call')).toBeVisible({ timeout: 15_000 })

  await context.setOffline(true)
  const banner = page.getByRole('status').filter({ hasText: /offline/i })
  await expect(banner).toBeVisible()

  await context.setOffline(false)
  await expect(banner).toHaveCount(0)
})

test('a page that does not exist says so without saying why', async ({ page }) => {
  await page.goto('/definitely-not-a-page')
  // "does not exist, or is not visible to you" — for a privacy product the two must be
  // indistinguishable from outside, so the copy is pinned here.
  await expect(page.getByText(/does not exist, or is not visible to you/i)).toBeVisible()
  await expect(page.getByRole('link', { name: /back to your calendar/i })).toBeVisible()
})
