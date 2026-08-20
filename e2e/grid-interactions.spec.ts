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

test('the month view stays display-only', async ({ page, isMobile }) => {
  // Pins the recorded decision in month-grid.tsx: entries are spans inside the cell
  // link, and the doors live one click away in the day view.
  await page.goto('/?view=month')
  // The phone's cells carry marks rather than titles, so the wait is for the grid itself.
  if (isMobile) {
    await expect(page.getByRole('link', { name: /^Show 2026-05-19.*event/ })).toBeVisible({
      timeout: 15_000,
    })
  } else {
    await expect(page.getByText('Team Standup').first()).toBeVisible({ timeout: 15_000 })
  }
  /*
   * SCOPED TO THE GRID, and the scoping is the point rather than a way round a red test.
   *
   * The decision being pinned is about the CELL: an interactive entry inside the cell's own
   * <Link> is interactive-inside-interactive, so entries are spans and the doors live one
   * click away. That is unchanged.
   *
   * What changed is that the phone's month view now carries the selected day's agenda under
   * the grid, and agenda rows have always had both doors. A page-wide count of zero would
   * therefore be asserting that the month page offers no way to edit anything, which was
   * never the decision and is not desirable -- the whole point of the inline agenda is that
   * the words and the controls live where there is room for them.
   */
  const grid = page.locator('[class*="month-grid_grid"]')
  await expect(grid.getByRole('button', { name: /^Edit the event at/ })).toHaveCount(0)
  await expect(
    grid.getByRole('button', { name: /^Change who can see the event at/ }),
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

/*
 * THE SNAPPED COLUMN MUST CLEAR THE STICKY HOUR GUTTER.
 *
 * `.corner`, `.allDayLabel` and `.gutter` are `position: sticky; left: 0` with an opaque
 * background and `z-index: 2`, and every column carries `scroll-snap-align: start`. "Start"
 * means flush with the scrollport's left edge, which is exactly where the gutter is pinned --
 * so before `scroll-padding-left` every snap position buried a column's left 52px. On a 390px
 * phone that is half of a 104px column: the Tuesday header rendered as "JE" over "9" instead
 * of "TUE 19", and taps in that strip hit the gutter rather than the block trigger underneath.
 *
 * It is absent at rest and appears from the FIRST SWIPE, which is why every gate missed it and
 * why it took a screenshot taken at a snap position to see at all.
 *
 * Asserted as the property rather than by driving a gesture and measuring where it lands:
 * `proximity` snapping is not obliged to snap, the settle has no event to wait on, and a test
 * that scrolls-then-measures would be timing a browser heuristic. The property is the fix, it
 * is one declaration, and reading it back catches the only realistic regression -- somebody
 * moving `--gutter-width` back onto `.grid`, where `scroll-padding-left` cannot see it and
 * this silently resolves to 0.
 */
test('a snapped day column is not parked under the sticky hour gutter', async ({ page }) => {
  await page.goto('/?view=week')
  await settle(page)

  const geometry = await page.evaluate(() => {
    const scroller = document.querySelector('[class*="week-grid_scroller"]')
    const gutter = document.querySelector('[class*="week-grid_gutter"]')
    if (scroller === null || gutter === null) return null
    return {
      scrollPaddingLeft: getComputedStyle(scroller).scrollPaddingLeft,
      gutterWidth: Math.round(gutter.getBoundingClientRect().width),
    }
  })

  expect(geometry).not.toBeNull()
  // Non-zero, and the same width as the thing it is clearing.
  expect(geometry?.scrollPaddingLeft).toBe(`${geometry?.gutterWidth}px`)
  expect(geometry?.gutterWidth).toBeGreaterThan(0)
})
