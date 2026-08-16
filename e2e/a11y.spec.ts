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

test('exposes one main landmark and a skip link that works', async ({ page }) => {
  await expect(page.getByRole('main')).toHaveCount(1)

  await page.keyboard.press('Tab')
  const skip = page.getByRole('link', { name: /skip to calendar/i })
  await expect(skip).toBeFocused()

  await skip.press('Enter')
  await expect(page).toHaveURL(/#main$/)
})

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

  test('the demo scans clean in every audience state', async ({ page }) => {
    // A control behind a click is a control nobody tested: axe runs against each state
    // the tabs can produce, not only the server-rendered one.
    await page.goto('/?landing=1')
    // exact: true — "You" is a substring of "Your client" under the default name match.
    for (const tab of ['Your client', 'Everyone else', 'You']) {
      await page.getByRole('button', { name: tab, exact: true }).click()
      await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))
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
  ['security', '/settings/security'],
  ['people', '/people'],
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
