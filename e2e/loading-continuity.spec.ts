import { expect, test } from '@playwright/test'

/**
 * A LOADING FALLBACK BECOMES ITS DESTINATION. It does not hand off to a blank one.
 *
 * The sequence this file forbids, reported after the mobile redesign:
 *
 *   current page -> OLD mobile shell -> invisible destination -> rising destination
 *
 * Two causes, and they need different kinds of test.
 *
 * THE CHROME DRIFT is structural: `app/loading.tsx` drew a wordmark where the phone header
 * shows the mark alone, a theme toggle the phone header hides, and no Settings control where
 * the phone header has one. That is asserted in `loading-shell.client.test.ts` against the
 * SOURCE, because the fallback and the real header now share the same classes and the only
 * way they can drift again is by editing one of them. What this file adds is the other half:
 * that the values the source test pins are the values the DESTINATION actually has, so the
 * two are compared against reality rather than against my assumption.
 *
 * WHY NOT HOLD THE NAVIGATION AND LOOK. Measured, not assumed: with the response for `/`
 * fully held, Next never renders the loading boundary at all — it keeps the previous route
 * painted until the payload arrives, which is exactly why `ui/nav-pending.tsx` exists in this
 * product. A test that clicks through and waits for the fallback waits fifteen seconds for
 * something that is never coming. Blocking the chunk files instead does not help either: the
 * fallback-to-content swap is an inline script, not a chunk.
 *
 * THE SECOND ENTRANCE is a live fact and is tested live, below.
 *
 * WHAT IS NOT ASSERTED HERE, AND WHY. There is no measurement of the fallback's PAINTED
 * geometry against the destination's. Three ways to get one were tried and all three are
 * unsound: holding the response never renders the boundary (above); blocking the chunk files
 * does not stop the swap, which is an inline script; and re-serving a truncated copy of the
 * streamed HTML paints something whose layout is not the page's (an 850px header, measured).
 *
 * Geometry equality is held by CONSTRUCTION instead -- the fallback and the destination now
 * draw the same classes, `cal.headerSettings`, `cal.headerTheme` and the audience row's own
 * footprint -- and that shared usage is what the source test pins. Measuring it for real
 * needs a slow network on a device, which is on the release gate with the rest of the phone
 * work. Recorded rather than papered over.
 *
 * For reference, the settled phone values this was checked against: header 69px, audience row
 * 44px, first main content at 129px.
 */

const PHONE_ROUTES = ['/', '/settings', '/people'] as const

test('the calendar header is what the fallback claims it is', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the contract under test is the phone header')

  await page.goto('/')
  await expect(page.getByRole('main')).toBeVisible()

  const chrome = await page.evaluate(() => {
    const painted = (el: Element | null) => {
      if (el === null) return false
      const box = el.getBoundingClientRect()
      return box.width > 1 && box.height > 1
    }
    return {
      wordmark: painted(document.querySelector('[class*="cloak-logo_wordmark"]')),
      settings: painted(document.querySelector('[class*="headerSettings"]')),
      theme: painted(document.querySelector('[class*="headerTheme"]')),
    }
  })

  // These three are the fallback's target. If any of them changes, the source test in
  // loading-shell.client.test.ts is pinning the wrong shape and this is what says so.
  expect(chrome.wordmark, 'the phone header shows the mark alone').toBe(false)
  expect(chrome.settings, 'the phone header carries the Settings control').toBe(true)
  expect(chrome.theme, 'the theme toggle is desktop chrome').toBe(false)
})

/*
 * The surfaces a ROUTE renders into. Deliberately a list rather than "every element": the
 * uncloak wipe (`cloaked-text_reveal`) also starts at opacity 0 and is meant to — it is the
 * product's signature motion, spent on a sealed value becoming readable. Banning every
 * fade-from-zero on the page would ban that, which is the opposite of the intent here.
 *
 * What this names is the containers whose entrance duplicates the navigation itself.
 */
const SURFACES = [
  'main',
  '[class*="page-shell_content"]',
  '[class*="people-screen_main"]',
  '[class*="settings_sections"]',
  '[class*="settings-hub_doors"]',
  '[class*="settings-hub_door__"]',
  '[class*="month-grid_grid"]',
  '[class*="week-grid_scroller"]',
].join(', ')

for (const route of PHONE_ROUTES) {
  test(`no surface on ${route} begins at opacity zero`, async ({ page }) => {
    await page.goto(route)
    await expect(page.getByRole('main')).toBeVisible()

    const result = await page.evaluate((selector) => {
      const surfaces = [...document.querySelectorAll(selector)]
      const fading: string[] = []
      for (const surface of surfaces) {
        for (const animation of surface.getAnimations()) {
          const effect = animation.effect as KeyframeEffect | null
          if (effect === null) continue
          // The loading fallback's own `.pulse` is `iteration-count: infinite` and its
          // `finished` never resolves — the trap a11y.spec.ts documents at length.
          if (effect.getComputedTiming().iterations === Infinity) continue
          const startsInvisible = effect
            .getKeyframes()
            .some((frame) => frame.offset === 0 && String(frame['opacity'] ?? '') === '0')
          if (startsInvisible) fading.push(surface.className || surface.tagName)
        }
      }
      return { inspected: surfaces.length, fading }
    }, SURFACES)

    // Say how many surfaces were examined. A sweep that finds nothing and a sweep that
    // looks at nothing report the same empty array otherwise, which this repo has shipped.
    expect(result.inspected, 'no route surfaces found to inspect').toBeGreaterThan(0)
    expect(result.fading, 'a surface fades up from transparent after its loading state').toEqual([])
  })
}
