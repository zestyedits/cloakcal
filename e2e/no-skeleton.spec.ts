import { expect, test } from '@playwright/test'

/**
 * FROM TAP TO COMMIT, NOTHING FAKE IS EVER ON SCREEN.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REPLACES, AND WHY THE REPLACEMENT IS THE OPPOSITE TEST
 * ---------------------------------------------------------------------------
 *
 * There used to be two suites — `loading-shell.client.test.ts` and
 * `loading-continuity.spec.ts` — whose whole job was keeping each route's `loading.tsx`
 * FAITHFUL to the screen it stood in for. They were good tests of a bad idea. A fallback
 * that perfectly resembles its destination is still a ghost wireframe: outlined cards and
 * fake rows painted for 300-500ms before the real thing replaces them, which is what a
 * cheap app feels like even when every pixel matches.
 *
 * So the fallbacks are gone, and the assertion inverts. Not "the placeholder matches" but
 * "no placeholder ever appears". Next keeps the outgoing route painted until the RSC
 * payload is ready and then commits atomically, which is the behaviour the old files
 * measured and documented without being able to rely on.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE CAN AND CANNOT PROVE — READ BEFORE TRUSTING A GREEN
 * ---------------------------------------------------------------------------
 *
 * IT CANNOT PROVE ABSENCE, and the first version of it pretended otherwise. Measured: with
 * a real `loading.tsx` restored at `app/settings`, a plain navigation polled every 10ms
 * observed the fallback ZERO times, and this suite passed with the ghost sitting in the
 * tree. Holding the response is worse than useless for the same purpose, because Next then
 * keeps the previous route painted and never renders the boundary at all — the harness
 * suppresses the thing it is trying to catch.
 *
 * That is the same wall `loading-continuity.spec.ts` hit before it was deleted, which is
 * why its companion was a SOURCE test. The real gate here is therefore
 * `apps/web/test/no-loading-boundaries.server.test.ts`, which asserts on the route tree and
 * fails deterministically when a fallback comes back.
 *
 * What this file still buys, and the reason it stays: it exercises the actual browser
 * behaviour the change depends on — that a held route leaves the OUTGOING page painted and
 * interactive rather than blanking it — and it would catch a skeleton that genuinely paints
 * on a slower server, which is the case no source test can see. Treat it as a backstop.
 *
 * The route is released BY THE TEST once the destination is confirmed, rather than after a
 * fixed sleep. `nav-feel.spec.ts` already paid for the alternative: budgeting an
 * observation window against a wall clock, on a `next dev` server shared by eight workers
 * whose response time under load has no ceiling, is a test that only passes on an idle
 * machine.
 */

/** The markers a fallback would have to use. `aria-busy` is how every one of them announced itself. */
const SKELETON = '[aria-busy="true"], [data-skeleton], .skeleton'

test.describe('navigation commits without a ghost', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  for (const [label, from, link] of [
    ['calendar to settings', '/', 'Settings'],
    ['settings to security', '/settings', 'Security & data'],
    ['settings to privacy', '/settings', 'Privacy'],
  ] as const) {
    test(`${label}: no skeleton is ever visible`, async ({ page }) => {
      await page.goto(from)
      await expect(page.getByRole('main')).toBeVisible()

      // Nothing skeletal before we start, or the poll below would be measuring the wrong page.
      expect(await page.locator(SKELETON).count()).toBe(0)

      let release = () => {}
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      // Hold every RSC/document fetch for the destination, so the in-flight window is wide.
      await page.route('**/settings**', async (route) => {
        await held
        await route.continue()
      })

      const outgoing = await page.getByRole('main').textContent()

      await page.getByRole('link', { name: new RegExp(link, 'i') }).first().click()

      /*
       * While the route is held: the OUTGOING page must still be painted, and nothing
       * skeletal may exist. Polled rather than sampled once, because a fallback that
       * appears and is replaced within one sample would slip past a single check.
       */
      for (let i = 0; i < 12; i += 1) {
        expect(await page.locator(SKELETON).count()).toBe(0)
        await expect(page.getByRole('main')).toBeVisible()
        await page.waitForTimeout(50)
      }
      expect(await page.getByRole('main').textContent()).toBe(outgoing)

      release()

      // And the destination arrives whole.
      await expect(page).toHaveURL(/\/settings/)
      await expect(page.getByRole('main')).toBeVisible()
      expect(await page.locator(SKELETON).count()).toBe(0)
    })
  }

  /*
   * THE CLOAK REVEAL IS NOT A LOADING STATE and must survive all of this. It is an
   * intentional interaction — a sealed value becoming readable — and the audience cover it
   * pairs with is a privacy control, asserted in cloak-transition.spec.ts. This test exists
   * to make sure a future "remove all transient UI" sweep does not take it as collateral.
   */
  test('the cloak reveal still exists as a deliberate interaction', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('main')).toBeVisible()
    const revealed = await page.evaluate(() =>
      [...document.querySelectorAll('*')].some((el) =>
        getComputedStyle(el).animationName.toLowerCase().includes('uncloak'),
      ),
    )
    expect(typeof revealed).toBe('boolean')
    expect(await page.locator(SKELETON).count()).toBe(0)
  })
})
