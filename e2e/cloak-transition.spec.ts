import { expect, test, type Page } from '@playwright/test'
import { switchAudience } from './sheet'

/**
 * The cloak — what the calendar does while an audience change is in flight.
 *
 * This is the product's signature moment and, more importantly, the one place where a slow
 * server could put a disclosure gap on screen. Every route is force-dynamic, so switching
 * audience is a full round trip with the OLD frame still painted. What is on screen during
 * that trip is the subject of this file.
 *
 * THE RULE, in one line: narrowing must hide immediately, widening may wait.
 *
 * The failure being guarded against is specific and was nearly shipped. The first draft of
 * the cover was `opacity: 0.5; filter: blur(2px)`, which looks like redaction and is not: a
 * 2px blur leaves a title substantially legible, and it does nothing at all to the
 * accessibility tree, so the owner's full titles would have stayed readable to a screen
 * reader for the whole fetch while the arriving frame said "Previewing as Dana".
 *
 * HOW THE MID-FLIGHT STATE IS OBSERVED. The response is held by the TEST — routed, and
 * released only once the assertion has run. Deliberately not held for a fixed number of
 * milliseconds: nav-feel.spec.ts already paid for budgeting an observation window against a
 * wall clock on a dev server shared by eight workers, and this window would be exactly as
 * fragile. Releasing on the assertion makes the mid-flight state something the test PROVES it
 * observed rather than something it hoped to be fast enough to catch.
 */

/** The demo's own audiences; `dev-fixture.ts` is where these ids come from. */
const RESTRICTED = 'contact:alex'
/*
 * The same audience, named. The phone has no `<select>` since the mobile pass -- its picker
 * is the Cloak sheet, whose rows are named "View as {name}" -- so the switch needs the id
 * for one device and the name for the other. `switchAudience` takes both and picks.
 */
const RESTRICTED_NAME = /^View as .*alex/i

/**
 * Hold the next document navigation until `release()` is called.
 *
 * `**\/?*` rather than a path: an audience switch is a client-side router push, so what has to
 * be held is the RSC fetch for `/`, which carries the same pathname and differing query.
 */
async function holdNextNavigation(page: Page) {
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let armed = true

  await page.route('**/?*', async (route) => {
    if (!armed) return route.continue()
    armed = false
    await held
    await route.continue()
  })

  return { release: () => release() }
}

test('narrowing covers the calendar, opaquely, before the new frame arrives', async ({ page, isMobile }) => {
  await page.goto('/')
  await expect(page.getByRole('main')).toBeVisible()

  const { release } = await holdNextNavigation(page)
  await switchAudience(page, isMobile, RESTRICTED, RESTRICTED_NAME)

  // The plate is on screen while the server is still thinking.
  const cover = page.getByText(/Changing view to/i)
  await expect(cover).toBeVisible()

  /*
   * OPAQUE, asserted on the computed value rather than on a class name. A class assertion
   * would pass just as happily against the blurred half-measure this replaced, which is the
   * whole thing being defended against.
   */
  const paint = await cover.evaluate((node) => {
    const plate = node.parentElement as HTMLElement
    const style = getComputedStyle(plate)
    return {
      opacity: Number(style.opacity),
      filter: style.filter,
      background: style.backgroundColor,
    }
  })
  expect(paint.opacity).toBe(1)
  // A blur would leave the titles underneath readable. It must not be reachable here.
  expect(paint.filter === 'none' || paint.filter === '').toBe(true)
  // An opaque ground, never a translucent wash.
  expect(paint.background).not.toMatch(/rgba\([^)]*,\s*0?\.\d+\)/)

  release()
  await expect(page.getByText(/Previewing as/i)).toBeVisible({ timeout: 15_000 })
})

test('the stale calendar leaves the accessibility tree at the same instant', async ({ page, isMobile }) => {
  await page.goto('/')
  // Something owner-level is genuinely on screen first, so the assertion below is not vacuous.
  await expect(page.getByRole('main')).toBeVisible()

  const { release } = await holdNextNavigation(page)
  await switchAudience(page, isMobile, RESTRICTED, RESTRICTED_NAME)
  await expect(page.getByText(/Changing view to/i)).toBeVisible()

  /*
   * `inert` is the assertion, not `aria-hidden`. Per the HTML spec an inert subtree is
   * removed from the accessibility tree AND unfocusable AND untargetable by pointer events —
   * strictly stronger than aria-hidden, which only does the first. Stacking both would invite
   * a false `aria-hidden-focus` finding from axe.
   */
  const inert = await page
    .locator('main#main')
    .evaluate((node) => (node as HTMLElement).inert === true)
  expect(inert).toBe(true)

  release()
  await expect(page.getByText(/Previewing as/i)).toBeVisible({ timeout: 15_000 })
})

test('widening retains the smaller view instead of blanking it', async ({ page }) => {
  await page.goto(`/?as=${RESTRICTED}`)
  await expect(page.getByText(/Previewing as/i)).toBeVisible({ timeout: 15_000 })

  const { release } = await holdNextNavigation(page)
  await page.getByRole('button', { name: /back to my view/i }).click()

  /*
   * NO COVER, and that is the asymmetry rather than an omission: showing LESS than you are
   * entitled to is never a disclosure error, so there is nothing to hide on the way out. What
   * there must still be is an acknowledgment — a retained restricted view with no feedback is
   * indistinguishable from a calendar that ignored the click.
   */
  await expect(page.getByText('Changing view to your own.')).toBeVisible()
  const inert = await page
    .locator('main#main')
    .evaluate((node) => (node as HTMLElement).inert === true)
  expect(inert).toBe(false)

  release()
  await expect(page.getByText(/Previewing as/i)).toHaveCount(0, { timeout: 15_000 })
})

test('reduced motion keeps the cover and loses only the wipe', async ({ page, isMobile }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await expect(page.getByRole('main')).toBeVisible()

  const { release } = await holdNextNavigation(page)
  await switchAudience(page, isMobile, RESTRICTED, RESTRICTED_NAME)

  /*
   * The correctness half is not an animation. Reduced motion collapses --duration-cloak to
   * 1ms in tokens.css, so the plate simply appears — it must NOT be traded for nothing, and
   * the announcement must still name where you are going.
   */
  const cover = page.getByText(/Changing view to/i)
  await expect(cover).toBeVisible()
  const opacity = await cover.evaluate((node) =>
    Number(getComputedStyle(node.parentElement as HTMLElement).opacity),
  )
  expect(opacity).toBe(1)

  const inert = await page
    .locator('main#main')
    .evaluate((node) => (node as HTMLElement).inert === true)
  expect(inert).toBe(true)

  release()
  await expect(page.getByText(/Previewing as/i)).toBeVisible({ timeout: 15_000 })
})

test('the announcement names the audience and is a status, not an alert', async ({ page, isMobile }) => {
  await page.goto('/')
  await expect(page.getByRole('main')).toBeVisible()

  const { release } = await holdNextNavigation(page)
  await switchAudience(page, isMobile, RESTRICTED, RESTRICTED_NAME)

  // `status`, never `alert`: a navigation the user just asked for is not an interruption.
  const status = page.getByRole('status').filter({ hasText: /Changing view to/i })
  await expect(status).toBeVisible()

  release()
  await expect(page.getByText(/Previewing as/i)).toBeVisible({ timeout: 15_000 })
})
