import { expect, test } from '@playwright/test'

/**
 * Public holidays on the calendar, and the switch that turns them off.
 *
 * WHAT THE FIXTURE CAN AND CANNOT SEE, because it shapes every test below. The demo week is
 * pinned to 18–24 May 2026 (DEMO_WEEK) and agenda/week cannot navigate off it, and there is
 * no public holiday in that window in ANY region we ship — Memorial Day and the UK Spring
 * Bank Holiday are both the 25th, one day past the edge. So the agenda and week grid are
 * structurally unable to show a holiday under the fixture.
 *
 * Month view IS testable: it is pinned to May 2026, which holds Memorial Day on the 25th and
 * Mother's Day on the 10th — one public holiday and one observance, which is exactly the pair
 * needed to prove the two tiers render differently. The mini month draws the same month, so
 * its marker is reachable too. The agenda's merge logic (a holiday on a day with no events
 * still gets a heading) is covered by unit tests instead, which is the honest split rather
 * than a spec that pretends to check it.
 */

const MONTH = '/?view=month'

test('the month grid names a public holiday and an observance, weighted differently', async ({
  page,
}) => {
  await page.goto(MONTH)

  // Memorial Day, 25 May 2026 — verified against the published calendar in
  // packages/domain/src/holidays.test.ts, not against the implementation.
  const holidays = page.locator('[data-kind]')
  await expect(page.getByTitle('Memorial Day')).toBeVisible()
  await expect(page.getByTitle("Mother's Day")).toBeVisible()

  // The only distinction between a day off and a day people mark is one step of ink. Pinned
  // as an attribute rather than a computed colour: the colours themselves are CONTRAST_PAIRS'
  // job, and asserting on a hex here would duplicate that badly.
  await expect(page.getByTitle('Memorial Day')).toHaveAttribute('data-kind', 'public')
  await expect(page.getByTitle("Mother's Day")).toHaveAttribute('data-kind', 'observance')
  expect(await holidays.count()).toBeGreaterThanOrEqual(2)
})

test('a holiday is never dressed as an event or given a privacy level', async ({ page }) => {
  await page.goto(MONTH)

  const memorial = page.getByTitle('Memorial Day')
  await expect(memorial).toBeVisible()

  // THE test in this file. A holiday is public by definition — there is nothing to redact —
  // so it must carry no privacy chip, no calendar colour and no door into an edit sheet.
  // Rendering one in the four learned privacy inks would teach that a public date and a
  // cloaked event are the same kind of thing, which is the product's central distinction.
  expect(await memorial.getAttribute('data-color')).toBeNull()
  expect(await memorial.getAttribute('data-privacy')).toBeNull()

  // It sits on the date line, not in the entries list, so it cannot be mistaken for one of
  // the day's events or push a real one into "+N more".
  await expect(memorial.locator('xpath=..')).toHaveClass(/dateLine/)
})

test('the mini month marks the day without inventing space for a name', async ({ page }) => {
  await page.goto(MONTH)

  // The sidebar mini month is desktop-only chrome; the phone project gets the week strip.
  const mini = page.getByRole('navigation', { name: 'Jump to a day' })
  test.skip((await mini.count()) === 0, 'mini month is desktop chrome')

  // The marked day carries the holiday NAME in its accessible name, so the underline is
  // never the only carrier of the fact. That is the whole reason the marker is allowed to be
  // a 1.5px rule at the edge of legibility.
  await expect(mini.getByRole('link', { name: /Memorial Day/ })).toHaveAttribute(
    'data-holiday',
    'true',
  )

  // The observance is NOT marked: two tiers of hint in a 24px cell is decoration nobody can
  // decode, and if only one fits it should be the day the office is shut.
  const mothers = mini.getByRole('link', { name: /Mother's Day/ })
  expect(await mothers.getAttribute('data-holiday')).toBeNull()
})

test('the sidebar switch says which region, and turns holidays off', async ({ page }) => {
  await page.goto(MONTH)

  const toggle = page.getByRole('switch', { name: /Holidays/ })
  test.skip((await toggle.count()) === 0, 'the calendars list is desktop chrome')

  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  // Naming the region matters: "on" and "on but your timezone matches nothing we ship" look
  // identical without it, and the second one reads as broken.
  await expect(toggle).toContainText('United States')
  await expect(page.getByTitle('Memorial Day')).toBeVisible()

  await toggle.click()

  // Off is a real stored state (the tri-state's 'off'), not a cleared region, and it survives
  // the server round trip that router.refresh() forces.
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(toggle).toContainText('Off')
  await expect(page.getByTitle('Memorial Day')).toHaveCount(0)

  // Back on, so the demo cookie does not leak an off state into whatever runs next.
  await toggle.click()
  await expect(page.getByTitle('Memorial Day')).toBeVisible()
})

test('the switch keeps a 44px target and states its own state', async ({ page }) => {
  await page.goto(MONTH)
  const toggle = page.getByRole('switch', { name: /Holidays/ })
  test.skip((await toggle.count()) === 0, 'the calendars list is desktop chrome')

  const box = await toggle.boundingBox()
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
})

test('Settings offers the region, and says nothing is fetched to work it out', async ({ page }) => {
  // Was `/settings#time-region`, which had to open the card it named before the select was
  // reachable — a hidden control is one `toBeEnabled()` passes against, and that exact mistake
  // sat green in settings.spec.ts for five commits. The band is simply on the page now.
  await page.goto('/settings/calendar')

  const select = page.getByLabel('Holidays')
  await expect(select).toBeVisible()
  await expect(select).toBeEnabled()

  // `auto` names what it resolved to rather than leaving the user to guess whether it found
  // anything at all.
  await expect(select.locator('option[value="auto"]')).toHaveText(
    'Match my timezone (United States)',
  )
  await expect(select.locator('option[value="off"]')).toHaveText('Do not show holidays')

  // The privacy claim on this surface has to be true and has to be plain (rule 1): the list
  // is built in, so there is no request that could carry a country or a calendar anywhere.
  await expect(page.getByText(/Nothing is fetched/)).toBeVisible()

  // Every region the app offers is selectable — a picker with a region the CHECK constraint
  // refuses would throw on save, which is what holiday-prefs.test.ts pins from the other end.
  for (const region of ['United States', 'Ireland', 'New Zealand']) {
    await expect(select.locator('option', { hasText: region }).first()).toHaveCount(1)
  }
})

test('choosing a region in Settings changes what the calendar draws', async ({ page }) => {
  await page.goto('/settings/calendar')
  await page.getByLabel('Holidays').selectOption('GB')

  await page.goto(MONTH)
  // The UK Spring Bank Holiday is also 25 May 2026, so the DATE is not evidence of anything;
  // the NAME is. Memorial Day must be gone and the bank holiday present.
  await expect(page.getByTitle('Spring Bank Holiday')).toBeVisible()
  await expect(page.getByTitle('Memorial Day')).toHaveCount(0)

  // Mothering Sunday, not the May date — the GB table's one genuinely different rule, and
  // proof the region switch reaches the rule table rather than just relabelling.
  await expect(page.getByTitle("Mother's Day")).toHaveCount(0)

  await page.goto('/settings/calendar')
  await page.getByLabel('Holidays').selectOption('auto')
})

test('no em dash anywhere the holiday copy renders', async ({ page }) => {
  await page.goto('/settings/calendar')
  // The repo-wide rule, asserted per surface. A DOM assertion rather than review, per
  // CLAUDE.md. Scoped to main rather than to the old `#time-region` card, which no longer
  // exists — and `main` is the right scope anyway, since it covers the copy that moved.
  const text = await page.locator('main').innerText()
  expect(text).not.toContain('—')
})
