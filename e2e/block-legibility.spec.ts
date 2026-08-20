import { expect, test } from '@playwright/test'

/**
 * NO BLOCK IN THE TIME GRID RENDERS WITHOUT AN IDENTITY.
 *
 * This file exists because the 2026-08-20 mobile pass fixed one unreadable state by creating
 * another. Titles were being sliced through the middle of their glyphs, so any text a block
 * could not hold was clipped -- and on a 95px phone column that blanked half the week, leaving
 * anonymous coloured rectangles. Colour and position are not an event model: the calendar
 * colours name a SOURCE, not a meaning, so a rectangle identifies nothing.
 *
 * The rule this pins: every visible block either carries a legible title, or is an aggregate
 * that says how many events it stands for. There is no third state.
 *
 * THE SWEEP REPORTS WHAT IT INSPECTED, and that is not decoration. The previous version of
 * this check passed while measuring an empty set -- every element it would have looked at was
 * already clipped to 1x1 and skipped by its own visibility filter, so "0 violations" and "0
 * examined" were indistinguishable. A blind sweep and a clean sweep look identical unless the
 * count is asserted too.
 */

const VIEWS = ['week', 'day'] as const

interface Audit {
  readonly inspected: number
  readonly titleless: readonly { readonly width: number; readonly height: number }[]
  readonly aggregates: readonly { readonly name: string; readonly text: string }[]
}

const audit = async (page: import('@playwright/test').Page): Promise<Audit> =>
  page.evaluate(() => {
    const painted = (el: Element) => {
      const box = el.getBoundingClientRect()
      return box.width > 1 && box.height > 1 && getComputedStyle(el).display !== 'none'
    }
    const blocks = [...document.querySelectorAll('[class*="week-grid_event__"]')].filter(painted)
    const titleless: { width: number; height: number }[] = []
    for (const block of blocks) {
      const title = block.querySelector('[class*="eventTitle"]')
      const legible =
        title !== null &&
        title.getBoundingClientRect().width > 2 &&
        (title.textContent ?? '').trim().length > 0
      if (!legible) {
        const box = block.getBoundingClientRect()
        titleless.push({ width: Math.round(box.width), height: Math.round(box.height) })
      }
    }
    return {
      inspected: blocks.length,
      titleless,
      aggregates: [...document.querySelectorAll('[class*="clusterBlock"]')]
        .filter(painted)
        .map((el) => ({
          name: el.getAttribute('aria-label') ?? '',
          text: (el.textContent ?? '').replace(/\s+/gu, ' ').trim(),
        })),
    }
  })

for (const view of VIEWS) {
  test(`every ${view} block carries a title or a count`, async ({ page }) => {
    await page.goto(`/?view=${view}`)
    await expect(page.getByRole('main')).toBeVisible()
    // Wait for a block to exist before auditing, or the sweep measures an empty grid and
    // reports the clean result it would report if everything were broken.
    await expect(page.locator('[class*="week-grid_event__"]').first()).toBeAttached({
      timeout: 15_000,
    })

    const result = await audit(page)

    expect(result.inspected, 'the sweep found no blocks to inspect').toBeGreaterThan(0)
    expect(result.titleless).toEqual([])
  })
}

test('an overlap collapses into a counted aggregate rather than blank plates', async ({
  page,
  isMobile,
}) => {
  test.skip(
    !isMobile,
    'a desktop column is wide enough to lane an overlap and keep both titles',
  )
  await page.goto('/?view=week')
  await expect(page.getByRole('main')).toBeVisible()
  await expect(page.locator('[class*="week-grid_event__"]').first()).toBeAttached({
    timeout: 15_000,
  })

  const result = await audit(page)
  expect(result.aggregates.length, 'the demo week has overlaps and none aggregated').toBeGreaterThan(0)

  for (const aggregate of result.aggregates) {
    // The COUNT and the EXTENT, both spoken. A screen reader gets no geometry, so the range
    // the block's height states visually has to be in the name.
    expect(aggregate.name).toMatch(/^\d+ overlapping events, \d{2}:\d{2} to \d{2}:\d{2}, open \d{4}-\d{2}-\d{2}$/u)
    // And the visible text carries the count, so the two cannot drift into different numbers.
    const spoken = aggregate.name.match(/^(\d+)/u)?.[1]
    expect(aggregate.text).toContain(`${spoken} events`)
  }
})

test('an aggregate opens the next surface with more room for that day', async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, 'aggregates only render where a lane cannot hold a title')

  // From the week, the roomier surface is the day: one column instead of three.
  await page.goto('/?view=week')
  const fromWeek = page.getByRole('link', { name: /overlapping events/u }).first()
  await expect(fromWeek).toBeVisible({ timeout: 15_000 })
  await expect(fromWeek).toHaveAttribute('href', /view=day/u)
  await fromWeek.click()
  await expect(page).toHaveURL(/view=day/u, { timeout: 15_000 })

  // From the day -- already one full-width column -- the roomier surface is the agenda,
  // which is a list and so terminates: there is no denser case for it to hand on to.
  const fromDay = page.getByRole('link', { name: /overlapping events/u }).first()
  if ((await fromDay.count()) > 0) {
    await expect(fromDay).toHaveAttribute('href', /view=agenda/u)
  }
})

test('a lone event is never narrowed by an overlap elsewhere in its day', async ({ page }) => {
  /*
   * The defect underneath the blank plates: `lanes` was computed once per DAY, so a single
   * 09:00-17:00 all-hands made every other event that day render at half width -- including
   * ones that overlapped nothing. Lanes are per cluster now, and this is what says so.
   */
  await page.goto('/?view=week')
  await expect(page.locator('[class*="week-grid_event__"]').first()).toBeAttached({
    timeout: 15_000,
  })

  const widths = await page.evaluate(() =>
    [...document.querySelectorAll('[class*="week-grid_event__"]')]
      .filter((el) => el.getBoundingClientRect().width > 1)
      .filter((el) => (el as HTMLElement).dataset['lanes'] === '1')
      .map((el) => Math.round((el.getBoundingClientRect().width / (el.parentElement?.getBoundingClientRect().width ?? 1)) * 100)),
  )

  expect(widths.length, 'no single-lane blocks to check').toBeGreaterThan(0)
  for (const width of widths) expect(width).toBeGreaterThan(90)
})
