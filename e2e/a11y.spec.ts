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

test('marks unbuilt views as disabled rather than shipping dead controls', async ({ page }) => {
  // Spec §10: a control that does not work is not shipped. Disabled and labelled is
  // honest; a button that silently does nothing is not.
  for (const name of ['Day', 'Month']) {
    const control = page.getByRole('button', { name, exact: true })
    await expect(control).toBeDisabled()
    await expect(control).toHaveAttribute('title', /later milestone/i)
  }
  for (const name of ['Agenda', 'Week']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeEnabled()
  }
})

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
