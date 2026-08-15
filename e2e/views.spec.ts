import { expect, test } from '@playwright/test'

/**
 * Day and Month — two NEW render surfaces for redacted data, which is why the leak canary
 * sweep from the week view runs here too: every surface that renders occurrences is a
 * surface redaction can be forgotten on.
 *
 * The fixture pins week/agenda to the demo week, honours day anchors inside it, and pins
 * month to May 2026 — so these assertions are deterministic.
 */

const CANARIES = ['Legal Call', 'Bramblewick handover', 'Quarrystone Room']

test('the day view shows one day of the demo week with its heading', async ({ page }) => {
  await page.goto('/?view=day&date=2026-05-19')
  await expect(page.getByText('Tuesday, May 19, 2026')).toBeVisible()
  // The daily standup lands on every weekday, so it must be here...
  await expect(page.getByText('Team Standup')).toBeVisible({ timeout: 15_000 })
  // ...and a Wednesday-only event must NOT be.
  await expect(page.getByText('Legal Call')).toHaveCount(0)
})

test('the day steppers move one day and keep the view', async ({ page }) => {
  await page.goto('/?view=day&date=2026-05-19')
  await page.getByRole('link', { name: 'Next day' }).click()
  await expect(page).toHaveURL(/view=day/)
  await expect(page).toHaveURL(/date=2026-05-20/)
  await expect(page.getByText('Wednesday, May 20, 2026')).toBeVisible()
})

test('the day page week strip is seven day links with the shown day current', async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, 'the strip is mobile chrome')
  await page.goto('/?view=day&date=2026-05-19')
  const strip = page.getByRole('navigation', { name: 'Jump to a day' })
  await expect(strip.locator('a')).toHaveCount(7)
  await expect(strip.locator('a[aria-current="page"]')).toHaveCount(1)
  await strip.locator('a').first().click()
  await expect(page).toHaveURL(/view=day/)
})

test('the month view places the demo week in its cells', async ({ page }) => {
  await page.goto('/?view=month')
  // Scoped to the stepper nav: the sidebar's mini month ALSO says "May 2026" now that it
  // draws the anchor's month rather than the grid range's first month.
  await expect(page.getByLabel('Change month').getByText('May 2026')).toBeVisible()
  // The standup recurs across the demo week, so several cells carry it.
  await expect(page.getByText('Team Standup').first()).toBeVisible({ timeout: 15_000 })
  // Cells are doors into the day view. The event count disambiguates the cell from the
  // sidebar mini month's same-day link, which carries no count.
  await page.getByRole('link', { name: /Open 2026-05-19, \d+ events?/ }).click()
  await expect(page).toHaveURL(/view=day/)
  await expect(page).toHaveURL(/date=2026-05-19/)
})

test('the month steppers move one month and keep the view', async ({ page }) => {
  await page.goto('/?view=month')
  await page.getByRole('link', { name: 'Next month' }).click()
  await expect(page).toHaveURL(/view=month/)
  await expect(page).toHaveURL(/date=2026-06-01/)
})

test('both new surfaces withhold from a restricted audience exactly as the week does', async ({
  page,
}) => {
  for (const path of ['/?view=month&as=contact:alex', '/?view=day&date=2026-05-19&as=contact:alex']) {
    await page.goto(path)
    const html = await page.content()
    for (const canary of CANARIES) {
      expect(html, `${canary} leaked on ${path}`).not.toContain(canary)
    }
  }
})

test('the audience survives day and month steppers', async ({ page }) => {
  await page.goto('/?view=day&date=2026-05-19&as=contact:alex')
  await page.getByRole('link', { name: 'Next day' }).click()
  await expect(page).toHaveURL(/as=contact/)
})

/**
 * The default view, from the calendar rather than from Settings.
 *
 * These run against the demo's cookie-backed preferences, which is the only reason they
 * can run at all: before that the fixture had no prefs and this control had nowhere to
 * write. They cover the round trip that matters — set it here, and `/` with no query
 * opens on it — plus the regression that made the feature unusable, where a link built
 * for the agenda omitted its own view and the server read the omission as "month".
 */

test('a view can be made the default from the calendar, and the calendar opens on it', async ({
  page,
}) => {
  await page.goto('/?view=month')
  await page.getByRole('button', { name: 'Make Month my default view' }).click()

  // The button becomes a statement rather than a disabled control.
  await expect(page.getByText('Month is your default view')).toBeVisible()

  // `/` with no query is the actual claim being made.
  await page.goto('/')
  await expect(page.getByLabel('Change month')).toBeVisible()
})

test('agenda is still reachable once another view is the default', async ({ page }) => {
  await page.goto('/?view=month')
  await page.getByRole('button', { name: 'Make Month my default view' }).click()
  await expect(page.getByText('Month is your default view')).toBeVisible()

  // From month, Agenda is a real navigation, and its link must NAME agenda. While the
  // builders omitted the param for agenda, the server resolved the absence back to the
  // stored default and this click left the user exactly where they were.
  await page
    .getByRole('navigation', { name: 'Calendar views' })
    .first()
    .getByRole('link', { name: 'Agenda', exact: true })
    .click()
  await expect(page).toHaveURL(/view=agenda/)
  await expect(page.getByLabel('Change week')).toBeVisible()
})

test('previewing as someone else offers no default-view control', async ({ page }) => {
  // It is not the viewer's calendar and not their preference to set.
  await page.goto('/?view=month&as=contact:alex')
  await expect(page.getByRole('button', { name: /my default view/ })).toHaveCount(0)
})
