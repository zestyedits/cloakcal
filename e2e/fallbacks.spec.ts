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
  /*
   * NAMES THE PRODUCT, NOT "YOUR CALENDAR", and that is pinned rather than incidental.
   *
   * A SIGNED-OUT VISITOR REALLY DOES REACH THIS PAGE, and the route is worth naming because
   * the obvious reading says otherwise: middleware sends an unknown path to /sign-in, so it
   * looks like only a signed-in user (who does have a calendar) can see a 404. But
   * `matches()` is a PREFIX test -- `pathname === p || pathname.startsWith(p + '/')` -- so
   * anything under a public prefix is public too. Verified against production: /privacy/nope,
   * /terms/nope, /contact/nope and /sign-in/nope all answer 404 with no session, and those
   * are precisely the URLs strangers hold, since the legal and contact pages are the ones
   * handed to app stores, processors and regulators.
   *
   * "Back to your calendar" told those people they had one. The destination is unchanged;
   * only the promise it made was wrong.
   */
  await expect(page.getByRole('link', { name: /back to cloakcal/i })).toBeVisible()
  await expect(page.getByRole('link', { name: /your calendar/i })).toHaveCount(0)
})
