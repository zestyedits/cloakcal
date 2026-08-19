import { expect, test } from '@playwright/test'

/**
 * Availability: the hours you are open, and the shading they put on the calendar.
 *
 * The demo carries a Mon-to-Fri 9-to-5 week (DEFAULT_WEEK), so every surface here is
 * reachable without an account. EDITING is live in the demo and SAVING is not — the draft is
 * local state, so a select can be exercised without a workspace to write to, which is what
 * makes the interaction testable at all.
 *
 * The copy assertions are not padding. This is the first piece of booking and nothing else
 * reads it yet, so the page has to say so; a settings screen that implies a client can pick a
 * slot is the same overclaim rule 1 forbids in the privacy copy.
 */

test('the calendar page states the schedule and points at the editor', async ({ page }) => {
  /*
   * This used to open `/settings#availability` and assert the `<details>` it named was open,
   * because a link inside a collapsed card is one `toBeEnabled()` would pass against and
   * nobody could click. There is no collapsed card any more — Availability is a plain band on
   * /settings/calendar — so the hazard is retired rather than worked around.
   */
  await page.goto('/settings/calendar')

  // The state line is the formatted week, not a count: "Mon to Fri, 9:00 AM to 5:00 PM" is the
  // whole setting at a glance.
  await expect(page.getByText('Mon to Fri, 9:00 AM to 5:00 PM')).toBeVisible()

  const link = page.getByRole('link', { name: 'Open Availability' })
  await expect(link).toBeVisible()
  await link.click()
  await expect(page).toHaveURL(/\/settings\/availability$/)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Availability')
})

test('the page lists every weekday and says what it does not do yet', async ({ page }) => {
  await page.goto('/settings/availability')

  for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) {
    await expect(page.getByRole('heading', { name: day, level: 3 })).toBeVisible()
  }

  // Weekend is off in the default week, and it says "Unavailable" rather than rendering an
  // empty row that reads as unfinished.
  await expect(page.getByText('Unavailable').first()).toBeVisible()

  // THE assertion. Availability is booking prep and booking does not exist; the page must not
  // let a reader assume otherwise.
  await expect(page.getByText(/Nothing books itself yet/)).toBeVisible()
  await expect(page.getByText(/Booking pages are not built/)).toBeVisible()

  // And it must not advertise the thing it is not.
  for (const promise of ['Book a time', 'Share your booking link', 'Copy booking link']) {
    await expect(page.getByRole('button', { name: promise })).toHaveCount(0)
    await expect(page.getByRole('link', { name: promise })).toHaveCount(0)
  }
})

test('hours can be added and removed, and the demo cannot save them', async ({ page }) => {
  await page.goto('/settings/availability')

  const saturday = page.getByRole('heading', { name: 'Saturday', level: 3 })
  await expect(saturday).toBeVisible()

  const before = await page.getByLabel('From').count()
  await page
    .locator('li')
    .filter({ has: page.getByRole('heading', { name: 'Saturday' }) })
    .getByRole('button', { name: 'Add hours' })
    .click()
  expect(await page.getByLabel('From').count()).toBe(before + 1)

  await page.getByRole('button', { name: /Remove Saturday hours 1/ }).click()
  expect(await page.getByLabel('From').count()).toBe(before)

  // Editing is live; saving is what the demo cannot do, and the reason is on screen rather
  // than left to be discovered by clicking.
  await expect(page.getByRole('button', { name: 'Save hours' })).toBeDisabled()
  await expect(page.getByText(/Demo\. Sign in to set your own hours/)).toBeVisible()
})

test('the week grid shades the hours outside your availability', async ({ page }) => {
  await page.goto('/?view=week')

  // Decoration, so it is aria-hidden and has to be found by class rather than by role.
  const closed = page.locator('[class*="week-grid_closed"]')
  expect(await closed.count()).toBeGreaterThan(0)

  // It sits BEHIND the events and takes no clicks: a wash that swallowed a compose click on
  // an early-morning slot would be a real regression and an invisible one.
  await expect(closed.first()).toHaveCSS('pointer-events', 'none')

  // The grid's hour span is deliberately NOT widened to cover availability, so shading only
  // ever appears inside the hours already on screen. Nothing may extend past the column.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
})

test('the day view shades too, and the agenda does not pretend to', async ({ page }) => {
  await page.goto('/?view=day&date=2026-05-19')
  expect(await page.locator('[class*="week-grid_closed"]').count()).toBeGreaterThan(0)

  // The agenda has no time axis, so there is nothing to shade and it must not invent a band.
  await page.goto('/?view=agenda')
  await expect(page.locator('[class*="week-grid_closed"]')).toHaveCount(0)
})

test('never scrolls sideways at 390px', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the desktop project has no narrow viewport to overflow')
  await page.goto('/settings/availability')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

  // Two native selects and a button on one row is exactly the shape that has pushed this
  // project sideways before: a grid item's automatic minimum size is its content, and a
  // select sizes to its longest option.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
})

test('every control clears 44px', async ({ page }) => {
  await page.goto('/settings/availability')
  const small = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button, a[href], select'))
      .map((el) => ({
        label: (el.textContent ?? '').trim().slice(0, 30) || el.tagName,
        height: Math.round(el.getBoundingClientRect().height),
      }))
      .filter((m) => m.height > 0 && m.height < 44)
      .map((m) => `${m.label}: ${m.height}px`),
  )
  expect(small).toEqual([])
})

test('no em dash anywhere on the page', async ({ page }) => {
  await page.goto('/settings/availability')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  expect(await page.content()).not.toContain('—')
})
