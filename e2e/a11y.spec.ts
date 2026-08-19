import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

/**
 * Accessibility is a launch requirement (spec §2), so it is asserted rather than reviewed.
 *
 * axe catches the machine-checkable subset. The assertions after it cover the things axe
 * cannot see but this product specifically promises: reachable touch targets, a working
 * keyboard path, visible focus, and controls that are honestly disabled rather than inert.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('Legal Call')).toBeVisible({ timeout: 15_000 })
  // Let every entrance animation finish before any assertion runs. axe measures
  // COMPOSITED colour, so scanning mid-reveal reports contrast failures against frames
  // that are not finished painting — the documented trap from the edit-event spec, now
  // relevant on page load because titles play the uncloak wipe and rows stagger in.
  // Same pattern as `openSheet`, and correct under reduced motion (1ms, already done).
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))
})

test('has no detectable WCAG A or AA violations', async ({ page }) => {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()

  // Report the rule ids rather than a bare count, so a failure says what broke.
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])
})

/*
 * THE SKIP LINK IS IN THE ROOT LAYOUT, SO IT MUST BE TESTED ON MORE THAN ONE PAGE.
 *
 * This test used to run only against `/` and assert `toHaveURL(/#main$/)` after pressing
 * Enter. Both halves were weaker than the name "a skip link that works" claims:
 *
 *  - A fragment link sets `location.hash` whether or not ANYTHING carries that id. So the
 *    URL assertion proved the link had been activated, never that it landed anywhere. Two
 *    pages -- `not-found.tsx` and `error.tsx` -- rendered `<main>` with no `id`, so the
 *    bypass link on the two pages a lost or broken-out user is most likely to be reading
 *    went nowhere at all, and this assertion would have passed on both.
 *  - Running on one route cannot see that, because the defect is per-page while the control
 *    is global. The 404 is included below for exactly that reason: it is the cheapest page
 *    in the app to reach that does not share the calendar's layout body.
 *
 * The target assertion is what makes this a test of the mechanism rather than of the click.
 */
const SKIP_TARGET_PAGES = ['/', '/this-path-does-not-exist'] as const

for (const path of SKIP_TARGET_PAGES) {
  test(`exposes one main landmark and a skip link that lands on it (${path})`, async ({
    page,
  }) => {
    await page.goto(path)

    const main = page.getByRole('main')
    await expect(main).toHaveCount(1)
    // The link's destination, asserted to EXIST and to be the landmark it names.
    await expect(main).toHaveAttribute('id', 'main')

    await page.keyboard.press('Tab')
    const skip = page.getByRole('link', { name: /skip to main content/i })
    await expect(skip).toBeFocused()

    await skip.press('Enter')
    await expect(page).toHaveURL(/#main$/)
  })
}

test('gives every interactive control a 44px touch target', async ({ page }) => {
  // --touch-min is a hard floor, not an aspiration (WCAG 2.2 / iOS HIG).
  //
  // Reported as a list of "label: height" rather than a bare numeric assertion, so a
  // failure names the offending control instead of sending someone to a screenshot.
  const measured = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button, a[href]')).map((el) => ({
      label: (el.textContent ?? '').trim().slice(0, 30) || el.tagName,
      height: Math.round(el.getBoundingClientRect().height),
      width: Math.round(el.getBoundingClientRect().width),
      hidden: el.getBoundingClientRect().height === 0,
    })),
  )

  expect(measured.length).toBeGreaterThan(0)

  // Off-screen controls (the skip link, until focused) have no box to measure.
  const tooSmall = measured
    .filter((m) => !m.hidden)
    .filter((m) => m.height < 44)
    .map((m) => `${m.label}: ${m.height}px`)

  expect(tooSmall).toEqual([])
})

test('every view is a real control: toggles for the shared fetch, links for the rest', async ({
  page,
}) => {
  // Day and Month were disabled-with-a-tooltip for two milestones; now they are server
  // navigations. Agenda/Week stay instant client toggles because they share one fetch.
  const bar = page.getByRole('navigation', { name: 'Calendar views' }).first()
  for (const name of ['Day', 'Month']) {
    await expect(bar.getByRole('link', { name, exact: true })).toHaveAttribute('href', /view=/)
  }
  for (const name of ['Agenda', 'Week']) {
    await expect(bar.getByRole('button', { name, exact: true })).toBeEnabled()
  }
})

for (const [label, path] of [
  ['day', '/?view=day&date=2026-05-19'],
  ['month', '/?view=month'],
] as const) {
  test(`the ${label} view has no accessibility violations and sane headings`, async ({ page }) => {
    await page.goto(path)
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])

    const levels = await page.evaluate(() =>
      Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) =>
        Number(h.tagName.slice(1)),
      ),
    )
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(1)
    }
  })
}

test('the week view renders the same occurrences the agenda does', async ({ page }) => {
  // Both read one already-redacted page, so switching views can never disclose an
  // occurrence the audience was not sent. This asserts that equivalence rather than
  // trusting it: a week view that fetched its own data would be a second read path, and a
  // second read path is a second place redaction can be forgotten.
  await expect(page.getByText('Legal Call')).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: 'Week', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Week', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  )
  await expect(page.getByText('Legal Call')).toBeVisible()
})

test('the week view withholds from a restricted audience exactly as the agenda does', async ({
  page,
}) => {
  await page.goto('/?as=contact:alex')
  await page.getByRole('button', { name: 'Week', exact: true }).click()

  const html = await page.content()
  for (const canary of ['Legal Call', 'Bramblewick handover', 'Quarrystone Room']) {
    expect(html).not.toContain(canary)
  }
})

test('keeps every heading in a sensible order', async ({ page }) => {
  const levels = await page.evaluate(() =>
    Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) =>
      Number(h.tagName.slice(1)),
    ),
  )
  expect(levels.length).toBeGreaterThan(0)
  // No level may be skipped on the way down.
  for (let i = 1; i < levels.length; i += 1) {
    expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(1)
  }
})

test('honours reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.reload()
  await expect(page.getByText('Legal Call')).toBeVisible({ timeout: 15_000 })

  const duration = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--duration-base').trim(),
  )
  expect(duration).toBe('1ms')
})

test.describe('landing', () => {
  // The signed-out landing, through its fixture-gated door (see landing.spec.ts). It
  // overrides the file's beforeEach navigation by going somewhere else first thing.
  test('has no accessibility violations, sane headings, and 44px controls', async ({ page }) => {
    await page.goto('/?landing=1')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])

    const levels = await page.evaluate(() =>
      Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) =>
        Number(h.tagName.slice(1)),
      ),
    )
    expect(levels[0]).toBe(1)
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(1)
    }

    const measured = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button, a[href]')).map((el) => ({
        label: (el.textContent ?? '').trim().slice(0, 30) || el.tagName,
        height: Math.round(el.getBoundingClientRect().height),
        hidden: el.getBoundingClientRect().height === 0,
      })),
    )
    const tooSmall = measured
      .filter((m) => !m.hidden)
      .filter((m) => m.height < 44)
      .map((m) => `${m.label}: ${m.height}px`)
    expect(tooSmall).toEqual([])
  })

  test('the hero week scans clean in every audience state', async ({ page }) => {
    // A control behind a click is a control nobody tested: axe runs against each state the
    // person buttons can produce, not only the server-rendered one. Four states now rather
    // than three, and the fourth is the one worth having — `public` is the only state where
    // several blocks are ABSENT rather than merely quieter, so it is the only one that
    // exercises the grid with holes in it.
    await page.goto('/?landing=1')
    for (const person of ['Priya', 'Marcus', 'Everyone else', 'You']) {
      await page.getByRole('button', { name: new RegExp(person) }).click()
      /*
       * Bounded, for the three reasons the light sweep below documents in full: `a.finished`
       * resolves with the Animation object, an infinite animation never settles, and a
       * cancelled one rejects. Clicking a person cancels the reseal mid-flight by design, so
       * this call site can genuinely hit the third case — the old spelling here survived only
       * because the previous demo's animation was shorter than the click that followed it.
       */
      await page.evaluate(async () => {
        const settled = new Promise<void>((resolve) => setTimeout(resolve, 2_000))
        const painted = Promise.all(
          document
            .getAnimations()
            .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
            .map((a) => a.finished.catch(() => undefined)),
        ).then(() => undefined)
        await Promise.race([painted, settled])
      })
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()
      expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])
    }
  })
})

/*
 * THE LIGHT THEME, on every page that has one.
 *
 * Every axe run in this project scanned the dark theme, and the light theme is the one the
 * brand references actually specify the calendar in. That gap was not theoretical: it hid a
 * failing `--text-tertiary` (3.31 to 3.41 across the three surfaces, under AA at any size)
 * on the mini month's dates, the sidebar headings, every form legend and the security page's
 * hints; a `--status-success` used as a 12px label at 3.47; the settings rail's index dimmed
 * with opacity to 3.46; and the agenda's delete trigger dimmed the same way to 3.36. Four
 * separate defects, none visible to a dark-only sweep, all found the day one of these ran.
 *
 * A separate loop rather than a theme parameter on the runs above, because the toggle is a
 * click and the dark pass should not pay for it.
 */
for (const [label, path] of [
  ['calendar', '/'],
  ['week', '/?view=week'],
  ['month', '/?view=month'],
  ['settings', '/settings'],
  /*
   * BOTH NEW CHILDREN, and this is not optional. /settings is four links now, so scanning it
   * alone would scan four links and nothing else — every control in the product's settings
   * moved onto these two pages, and neither existed to any axe run until this line.
   */
  ['settings privacy', '/settings/privacy'],
  ['settings calendar', '/settings/calendar'],
  ['security', '/settings/security'],
  ['availability', '/settings/availability'],
  ['people', '/people'],
  /*
   * THE AUTH SCREENS HAD NEVER BEEN SCANNED, in either theme, by anything.
   *
   * Found while restyling them. Every axe run in this file covered the calendar, its views,
   * settings, security, people and the landing — and never `/sign-in`, `/sign-up` or
   * `/recover`, which are the first pages a stranger sees and the ones asking for a
   * password. The control pass replaced a transparent field with a filled one, which is
   * precisely the change that moves a contrast ratio without moving anything a human would
   * notice in review, so the gap and the change arrived together.
   *
   * They also matter more in LIGHT than the app does: --surface-raised is #ffffff there, so
   * the old field was white on white plus a 1.6:1 hairline.
   */
  ['sign in', '/sign-in'],
  ['sign up', '/sign-up'],
  ['recover', '/recover'],
  /*
   * PREVIEW MODE IS A PAGE STATE NOTHING HERE HAD EVER SCANNED.
   *
   * Every other entry above is a route; this one is the calendar wearing `<PreviewBar>`,
   * which no axe run reached because none of them passed `?as=`. The bar introduces a
   * ground the palette did not previously composite anywhere — --accent-quiet over
   * --surface-base — and the repo's own rule is that a colour checked as a SHAPE and a
   * colour used under TEXT are different pairs. That gap has shipped an AA failure twice.
   *
   * The engine decides what a restricted audience sees, so this also puts a redacted
   * calendar in front of axe for the first time in the light theme.
   */
  ['preview mode', '/?as=contact:alex'],
] as const) {
  test(`the ${label} page scans clean in the LIGHT theme`, async ({ page }) => {
    await page.goto(path)
    await page.getByRole('button', { name: 'Switch to light mode' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

    /*
     * Let paint settle before axe, WITHOUT a wait that can hang the suite.
     *
     * axe measures COMPOSITED colour, so scanning mid-animation reports contrast failures
     * against frames that are not finished painting. The repo's usual spelling is
     * `Promise.all(document.getAnimations().map((a) => a.finished))`, and on this page, in
     * the light theme, it hangs until the 30s test timeout. Three separate reasons it can,
     * all of them real and none of them obvious:
     *
     *   1. `a.finished` RESOLVES WITH THE ANIMATION OBJECT, so `Promise.all` hands Playwright
     *      an array of live host objects to serialise back across the bridge. The `async`
     *      body returning undefined is what stops that. Elsewhere in this suite the same
     *      call survives only because the array is empty by the time it runs.
     *   2. An INFINITE animation's `finished` never resolves, by construction. The loading
     *      fallbacks' `.pulse` is `iteration-count: infinite`.
     *   3. A CANCELLED transition REJECTS rather than resolving, and one rejection fails the
     *      whole `Promise.all`. Switching the theme retargets transitions mid-flight.
     *
     * The settle is still the mechanism; `settled` is a BACKSTOP, not a sleep standing in for
     * a wait. It bounds a promise that provably can fail to settle, and it stays correct
     * under prefers-reduced-motion because there the animations finish in 1ms and the race is
     * won by the real branch every time.
     */
    await page.evaluate(async () => {
      const settled = new Promise<void>((resolve) => setTimeout(resolve, 2_000))
      const painted = Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => undefined)),
      ).then(() => undefined)
      await Promise.race([painted, settled])
    })

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])
  })
}

/**
 * The export control, which is behind a click and therefore invisible to the sweep above.
 *
 * "axe only sees what is on screen, so a control behind a click is a control nobody tested"
 * — the lesson the delete confirmation taught this repo, where a 2.99:1 label on the one
 * irreversible action in the product survived every scan because nothing ever opened it.
 *
 * Scanned in LIGHT, because that is where this project's contrast failures have actually
 * been: --surface-raised is #ffffff there, and every failure the light sweep has found was
 * invisible in dark.
 */
test('the export control scans clean in the LIGHT theme', async ({ page }) => {
  /*
   * KEPT, not deleted, when export moved off the Calendars card. It is no longer behind a
   * disclosure — /settings/security renders it outright — so the "control behind a click"
   * argument no longer applies to this one control; what still applies is that the button is
   * a filled surface in the theme where every contrast failure this project has shipped was
   * found, and the whole page is now in the light sweep above with it.
   */
  await page.goto('/settings/security')
  await page.getByRole('button', { name: 'Switch to light mode' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  const button = page.getByRole('button', { name: 'Export as .ics' })
  await expect(button).toBeVisible()

  // axe measures COMPOSITED colour, so scanning mid-animation reports a card as a contrast
  // failure against a box that is not painted yet. Same bounded settle as the sweep above,
  // and for the same three reasons.
  await page.evaluate(async () => {
    const settled = new Promise<void>((resolve) => setTimeout(resolve, 2_000))
    const painted = Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ).then(() => undefined)
    await Promise.race([painted, settled])
  })

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])

  // The 44px floor, measured on the control itself rather than inferred from the page sweep.
  const box = await button.boundingBox()
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
})
