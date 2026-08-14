import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

/**
 * Week and day blocks as doors: the block opens the edit sheet, the privacy second line
 * opens the Event Visibility sheet — the agenda's model, in the grid. Month stays
 * display-only (pinned below, so changing that is a decision rather than a drift).
 *
 * Accessible names here are built from times only, never titles; the assertions match
 * that shape on purpose.
 *
 * NO 44px SWEEP FOR BLOCKS, STATED RATHER THAN LOOKING LIKE AN OVERSIGHT: a 30-minute
 * event in a 56px-per-hour grid is ~28px tall, and the same actions exist at ≥44px on
 * the agenda over the same fetch (WCAG 2.5.8 equivalence). The chip button keeps a 24px
 * box, the 2.5.8 numeric floor.
 */

const settle = async (page: import('@playwright/test').Page) => {
  await expect(page.getByText('Legal Call')).toBeVisible({ timeout: 15_000 })
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))
}

const finishAnimations = async (page: import('@playwright/test').Page) => {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))
}

test('a week block opens the edit sheet', async ({ page }) => {
  await page.goto('/?view=week')
  await settle(page)

  await page.getByRole('button', { name: /^Edit the event at/ }).first().click()
  const dialog = page.locator('dialog[open]')
  await expect(dialog).toBeVisible()
  await finishAnimations(page)
  // Pre-filled from decrypted values: the sheet read the store, not the server.
  await expect(dialog.getByLabel('What is it')).not.toHaveValue('')
  // The sheet carries Delete now, which is what makes deleting reachable from the grid
  // views at all — edit-event.spec.ts covers the confirmation itself.
  await expect(dialog.getByRole('button', { name: /^Delete the/ })).toBeVisible()
})

test("a week block's privacy line opens the visibility sheet", async ({ page }) => {
  await page.goto('/?view=week')
  await settle(page)

  await page.getByRole('button', { name: /^Change who can see the event at/ }).first().click()
  await finishAnimations(page)
  await expect(page.getByRole('heading', { name: 'Event visibility' })).toBeVisible()
})

test('the day view inherits both doors', async ({ page }) => {
  await page.goto('/?view=day&date=2026-05-19')
  await finishAnimations(page)

  await expect(page.getByRole('button', { name: /^Edit the event at/ }).first()).toBeVisible()
  await page.getByRole('button', { name: /^Change who can see the event at/ }).first().click()
  await finishAnimations(page)
  await expect(page.getByRole('heading', { name: 'Event visibility' })).toBeVisible()
})

test('a restricted audience gets no doors at all', async ({ page }) => {
  for (const path of ['/?view=week&as=contact:sarah', '/?view=day&date=2026-05-19&as=contact:sarah']) {
    await page.goto(path)
    await expect(page.getByRole('button', { name: /^Edit the event at/ })).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: /^Change who can see the event at/ }),
    ).toHaveCount(0)
  }
})

test('the month view stays display-only', async ({ page }) => {
  // Pins the recorded decision in month-grid.tsx: entries are spans inside the cell
  // link, and the doors live one click away in the day view.
  await page.goto('/?view=month')
  await expect(page.getByText('Team Standup').first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: /^Edit the event at/ })).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: /^Change who can see the event at/ }),
  ).toHaveCount(0)
})

test('the week view scans clean, closed and with the edit sheet open', async ({ page }) => {
  await page.goto('/?view=week')
  await settle(page)

  const closed = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(closed.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])

  await page.getByRole('button', { name: /^Edit the event at/ }).first().click()
  await expect(page.locator('dialog[open]')).toBeVisible()
  // The composited-colour trap: never scan mid-rise.
  await finishAnimations(page)
  const open = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(open.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])
})
