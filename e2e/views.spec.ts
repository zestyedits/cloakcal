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

test('the day view shows one day of the demo week with its heading', async ({
  page,
  isMobile,
}) => {
  await page.goto('/?view=day&date=2026-05-19')
  /*
   * THE PHONE'S HEADING IS THE MONTH, AND THAT IS THE ONE-DATE RULE RATHER THAN A LOSS.
   *
   * "Tuesday, May 19, 2026" is 25 characters into a ~102px box: it wrapped to three lines
   * and took the header from 69px to 97px on the one view that needs the room most. The full
   * date is directly below in the week strip, ringed, as a link -- so the phone shows the
   * SCOPE here and the DATE there, and the day appears exactly once on the screen.
   */
  await expect(
    page.getByText(isMobile ? 'May 2026' : 'Tuesday, May 19, 2026').first(),
  ).toBeVisible()
  if (isMobile) {
    // The date is still on screen, and still the thing that carries it.
    const strip = page.getByRole('navigation', { name: 'Jump to a day' })
    await expect(strip.locator('a[aria-current="page"]')).toHaveText(/19/)
  }
  // The daily standup lands on every weekday, so it must be here...
  await expect(page.getByText('Team Standup')).toBeVisible({ timeout: 15_000 })
  // ...and a Wednesday-only event must NOT be.
  await expect(page.getByText('Legal Call')).toHaveCount(0)
})

test('the day steppers move one day and keep the view', async ({ page, isMobile }) => {
  await page.goto('/?view=day&date=2026-05-19')
  await page.getByRole('link', { name: 'Next day' }).click()
  await expect(page).toHaveURL(/view=day/)
  await expect(page).toHaveURL(/date=2026-05-20/)
  // Same split as the test above: the phone's header names the month, the strip the day.
  if (isMobile) {
    const strip = page.getByRole('navigation', { name: 'Jump to a day' })
    await expect(strip.locator('a[aria-current="page"]')).toHaveText(/20/)
  } else {
    await expect(page.getByText('Wednesday, May 20, 2026')).toBeVisible()
  }
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

test('the month view places the demo week in its cells', async ({ page, isMobile }) => {
  await page.goto('/?view=month')
  // Scoped to the stepper nav: the sidebar's mini month ALSO says "May 2026" now that it
  // draws the anchor's month rather than the grid range's first month.
  await expect(page.getByLabel('Change month').getByText('May 2026')).toBeVisible()
  /*
   * THE PHONE'S CELLS CARRY MARKS, NOT TITLES. A 49px cell rendered "Team s"; the title is
   * in the selected-day agenda under the grid, at full length, and in the cell's own
   * aria-label. Asserted on BOTH surfaces rather than skipped, because the capability -- the
   * demo week is placed in the month -- is real on both and only its expression differs.
   */
  if (isMobile) {
    await expect(page.getByRole('link', { name: /^Show 2026-05-19.*event/ })).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.locator('[class*="month-grid_entryTitle"]').first()).toBeHidden()
  } else {
    // The standup recurs across the demo week, so several cells carry it.
    await expect(page.getByText('Team Standup').first()).toBeVisible({ timeout: 15_000 })
  }
  /*
   * A CELL IS A DIFFERENT DOOR ON EACH DEVICE, and its accessible name says which.
   *
   * Desktop: "Open <day>" -- a link into the day view, unchanged. Phone: "Show <day>" --
   * the cell selects, and the day's events appear in full under the grid. The verb is part
   * of the name precisely so a test cannot assert one behaviour and get the other.
   *
   * The event count disambiguates the cell from the sidebar mini month's same-day link,
   * which carries no count.
   */
  if (isMobile) {
    await page.getByRole('link', { name: /Show 2026-05-19, \d+ events?/ }).click()
    // Selection, not navigation: the URL is untouched and the day's events are listed.
    await expect(page).not.toHaveURL(/view=day/)
    await expect(page.getByRole('heading', { name: /Tuesday, May 19/ })).toBeVisible()
    // Scoped to the AGENDA. A page-wide `getByText('Team Standup').first()` resolves to the
    // month cell's own entry title, which is `display: none` on a phone and comes first in
    // DOM order -- so the assertion would fail while the thing it is about is on screen.
    await expect(page.locator('main ol').getByText('Team Standup').first()).toBeVisible()
    // And the way into the full day view is still one tap.
    await page.getByRole('link', { name: 'Open day' }).click()
    await expect(page).toHaveURL(/view=day/)
    await expect(page).toHaveURL(/date=2026-05-19/)
    return
  }

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
 * The control has two presentations and only one is ever on screen: a bookmark inside the
 * desktop header's view track, and a labelled row in the phone's sidebar strip. Both are in
 * the DOM (CSS hides the other), so every locator here filters to the VISIBLE one — the
 * same shape as the Cloak button, which has had two mounts since the bottom bar existed.
 *
 * These run against the demo's cookie-backed preferences, which is the only reason they
 * can run at all: before that the fixture had no prefs and this control had nowhere to
 * write. They cover the round trip that matters — set it here, and `/` with no query
 * opens on it — plus the regression that made the feature unusable, where a link built
 * for the agenda omitted its own view and the server read the omission as "month".
 */

/*
 * DESKTOP CHROME NOW, and the skip is a design decision rather than a coverage gap.
 *
 * The "Make <view> my default view" row used to sit in the phone's sidebar strip, stacked
 * ABOVE the calendar — a preference occupying 44px of the most expensive space on the screen,
 * where the audit measured the first event landing 413px down an 844px phone. A preference
 * does not outrank the calendar, so on phones it moved to where preferences live: the Default
 * view select in `settings/appearance-section.tsx`, reachable from the header's Settings link.
 *
 * The desktop bookmark in the header's view track is unaffected and is what these two cover.
 */
test('a view can be made the default from the calendar, and the calendar opens on it', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'the phone sets a default view in Settings; the bookmark is desktop chrome')
  await page.goto('/?view=month')
  await page
    .getByRole('button', { name: 'Make Month my default view' })
    .filter({ visible: true })
    .click()

  // The control becomes a statement rather than a disabled control. Asserted on the
  // ACCESSIBLE NAME, which both presentations share — the bookmark carries no text.
  await expect(
    page.getByRole('button', { name: 'Month is your default view' }).filter({ visible: true }),
  ).toBeVisible()

  // `/` with no query is the actual claim being made.
  await page.goto('/')
  await expect(page.getByLabel('Change month')).toBeVisible()
})

test('agenda is still reachable once another view is the default', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the phone sets a default view in Settings; the bookmark is desktop chrome')
  await page.goto('/?view=month')
  await page
    .getByRole('button', { name: 'Make Month my default view' })
    .filter({ visible: true })
    .click()
  await expect(
    page.getByRole('button', { name: 'Month is your default view' }).filter({ visible: true }),
  ).toBeVisible()

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
