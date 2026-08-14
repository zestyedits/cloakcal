import { expect, test } from '@playwright/test'

/**
 * Perceived latency of server navigations — the two mechanisms shipped on perf/nav-feel:
 *
 *   1. A link whose navigation is in flight carries a [data-nav-pending] marker
 *      (ui/nav-pending.tsx), and the control wears its hover wash while it does — the
 *      click is acknowledged instead of silently ignored for the round trip.
 *   2. Arriving at `/` from another segment shows the full-shell loading fallback:
 *      the chrome persists, only the data shimmers. No freeze-and-teleport.
 *
 * Both states exist only WHILE the server is thinking, and the fixture answers in
 * ~10ms — so each test holds the navigation's request open with a route delay to make
 * the in-flight window observable. axe never sees these states for the same reason a
 * control behind a click needs a spec: they exist only mid-interaction, which is
 * exactly why they are opened deliberately here.
 */

test('a stepper click is acknowledged while the server thinks, and the cue clears', async ({
  page,
}) => {
  await page.goto('/?view=week&date=2026-05-19')
  const next = page.getByRole('link', { name: 'Next week' })
  await expect(next).toBeVisible()

  // Hold every fetch for the destination URL open — the intent prefetch and the
  // navigation itself both match, so the pending window is deterministic either way.
  await page.route(
    (url) => url.searchParams.get('date') === '2026-05-26',
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      await route.continue()
    },
  )

  await next.click()
  // The acknowledgment: the marker appears inside the clicked link well before the
  // navigation lands. No screenshot — colour is CONTRAST_PAIRS' job; presence is ours.
  await expect(next.locator('[data-nav-pending]')).toHaveCount(1)

  await expect(page).toHaveURL(/date=2026-05-26/)
  // And it clears: a cue that survives its navigation is a stuck spinner with less ink.
  await expect(page.locator('[data-nav-pending]')).toHaveCount(0)
})

test('returning to the calendar never drops the shell chrome', async ({ page }) => {
  await page.goto('/people')
  await expect(page.getByRole('heading', { name: 'People' })).toBeVisible()

  // NOT "the fallback is visible": whether the loading fallback ever PAINTS depends on
  // how the response chunks land relative to React's commit — hold the whole response
  // and fallback and content can commit together, so an assertion on the fallback's
  // visibility is a coin toss against server speed. The user-facing invariant is the
  // negative one: at no frame between People and the calendar is the chrome gone. A
  // bare-column fallback (the pre-2026-08 skeleton) fails this the moment it paints;
  // the full-shell fallback cannot. The fallback's STRUCTURE is pinned separately, in
  // apps/web/test/loading-shell.client.test.ts, where no race can vacate the check.
  await page.evaluate(() => {
    const w = window as typeof window & { __chromeLost?: boolean }
    w.__chromeLost = false
    const check = () => {
      if (!document.querySelector('header')) w.__chromeLost = true
      requestAnimationFrame(check)
    }
    requestAnimationFrame(check)
    new MutationObserver(check).observe(document.documentElement, {
      childList: true,
      subtree: true,
    })
  })

  await page.route(
    (url) => url.pathname === '/' && !url.searchParams.has('landing'),
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 800))
      await route.continue()
    },
  )

  await page.getByRole('link', { name: 'Back to calendar' }).click()
  await expect(page.getByText('Legal Call')).toBeVisible({ timeout: 20_000 })

  expect(
    await page.evaluate(() => (window as typeof window & { __chromeLost?: boolean }).__chromeLost),
  ).toBe(false)
})
