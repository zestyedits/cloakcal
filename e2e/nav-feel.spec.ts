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
 * ~10ms — so each test holds the navigation's request open to make the in-flight window
 * observable. axe never sees these states for the same reason a control behind a click needs
 * a spec: they exist only mid-interaction, which is exactly why they are opened deliberately
 * here.
 *
 * THE HOLD IS RELEASED BY THE TEST, NOT BY A TIMER, and that is a fix rather than a style.
 * Both tests used to hold the request for a fixed 800-1000ms and then assert. That budgets the
 * observation window against a wall clock while the thing being observed is a SHARED `next
 * dev` server: eight workers hit it at once, it compiles routes on demand, and its response
 * time under load has no ceiling. Measured over four full-suite runs, both tests in this file
 * failed on two of them — and the failures were never the mechanism. The pending marker was
 * always found; what timed out was the wait for the navigation to land afterwards, 1000ms of
 * self-inflicted delay already spent. Releasing the route once the marker has been seen makes
 * the window exactly as long as the assertion needs, removes the artificial delay from the
 * critical path entirely, and makes the mid-navigation state something this test PROVES it
 * observed rather than something it hopes it was fast enough to catch.
 */

/** A request held open until the test says otherwise. */
function heldRoute(): { hold: Promise<void>; release: () => void } {
  let release!: () => void
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  return { hold, release }
}

test('a stepper click is acknowledged while the server thinks, and the cue clears', async ({
  page,
}) => {
  await page.goto('/?view=week&date=2026-05-19')
  const next = page.getByRole('link', { name: 'Next week' })
  await expect(next).toBeVisible()

  // Hold every fetch for the destination URL open — the intent prefetch and the
  // navigation itself both match, so the pending window is deterministic either way.
  const { hold, release } = heldRoute()
  await page.route(
    (url) => url.searchParams.get('date') === '2026-05-26',
    async (route) => {
      await hold
      await route.continue()
    },
  )

  await next.click()
  // The acknowledgment: the marker appears inside the clicked link well before the
  // navigation lands. No screenshot — colour is CONTRAST_PAIRS' job; presence is ours.
  await expect(next.locator('[data-nav-pending]')).toHaveCount(1)

  // Observed. Let the navigation finish; everything after this is the server's own speed.
  release()
  await expect(page).toHaveURL(/date=2026-05-26/, { timeout: 20_000 })
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

  const { hold, release } = heldRoute()
  await page.route(
    (url) => url.pathname === '/' && !url.searchParams.has('landing'),
    async (route) => {
      await hold
      await route.continue()
    },
  )

  // "‹ Calendar" since People moved onto the shared PageShell: /settings, /people and
  // /settings/security had three arrangements of the same top bar, and now have one.
  await page.getByRole('link', { name: '‹ Calendar' }).click()

  /*
   * ASSERTED WHILE THE NAVIGATION IS HELD, which is what makes the mid-flight state something
   * this test observed rather than something it hoped to be fast enough to catch. The rAF and
   * MutationObserver above watch every frame either way; this pins that there WAS an in-flight
   * frame to watch.
   */
  // `.first()`, matching `document.querySelector('header')` in the watcher above — the same
  // element, deliberately. /people has three: the shell's top bar and two panel heads. Scoping
  // this to a different one would assert about chrome the watcher is not watching.
  await expect(page.locator('header').first()).toBeVisible()
  release()

  await expect(page.getByText('Legal Call')).toBeVisible({ timeout: 20_000 })

  expect(
    await page.evaluate(() => (window as typeof window & { __chromeLost?: boolean }).__chromeLost),
  ).toBe(false)
})
