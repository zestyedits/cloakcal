import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { settleSheet, sheet } from './sheet'

/**
 * The compose sheet — reachable at last. `composeDate` used to be undefined in fixture
 * mode, so <NewEvent> never rendered under Playwright and the whole create path had zero
 * coverage, axe included; that is exactly how the first sheet shipped claiming aria-modal
 * with none of it. The fixture now opens the sheet as a DEMO that structurally cannot
 * write: Save is disabled, submit refuses, and the workspace lookup is never made
 * (NewEvent.demo). What is covered here is everything up to the RPC — opening, slot
 * prefill, the demo refusal, and that nothing typed ever leaves the page. The real write
 * is proven against PGlite in packages/db/test/create-event.test.ts.
 */

const settle = async (page: Page) => {
  await expect(page.getByText('Legal Call')).toBeVisible({ timeout: 15_000 })
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))
}

/** The one visible compose trigger: the FAB on phones, the sidebar block from 900px.
 *  exact — role-name matching is substring by default, and every grid slot's name STARTS
 *  with "New event on". */
const composeButton = (page: Page) =>
  page.getByRole('button', { name: 'New event', exact: true }).filter({ visible: true })

// sheet() and settleSheet() live in ./sheet - three specs had a copy of this each.

test('opens from the compose button, prefilled on the anchor day', async ({ page }) => {
  await page.goto('/')
  await settle(page)

  await composeButton(page).click()
  const dialog = await settleSheet(page)

  // The fixture's anchor is pinned to the demo Tuesday; a real account gets today.
  await expect(dialog.getByLabel('Day')).toHaveValue('2026-05-19')
  await expect(dialog.getByLabel('Starts')).toHaveValue('09:00')
})

test('the demo cannot save, and says so instead of failing confusingly', async ({ page }) => {
  await page.goto('/')
  await settle(page)

  await composeButton(page).click()
  const dialog = await settleSheet(page)

  await expect(dialog.getByText(/nothing typed here is saved/)).toBeVisible()
  const save = dialog.getByRole('button', { name: 'Save' })
  await expect(save).toBeDisabled()

  // Filling the form does not talk Save out of its refusal: the demo's disabled state is
  // a property of the mode, not of the form being incomplete.
  await dialog.getByLabel('What is it').fill('A plan that will not be kept')
  await expect(save).toBeDisabled()
})

test('an empty week-grid slot composes at that day and hour', async ({ page }) => {
  await page.goto('/?view=week')
  await settle(page)

  // Tuesday 3 PM is empty in the demo week, so the slot is clickable rather than sitting
  // under an event block.
  await page.getByRole('button', { name: 'New event on 2026-05-19 at 3 PM' }).click()
  const dialog = await settleSheet(page)

  await expect(dialog.getByLabel('Day')).toHaveValue('2026-05-19')
  await expect(dialog.getByLabel('Starts')).toHaveValue('15:00')
})

test('the lower half of a slot asks for the half hour, the midpoint does not', async ({
  page,
}) => {
  /*
   * Position snapping, and the reason the midpoint belongs to the HOUR.
   *
   * The cell is named "at 3 PM", so an ambiguous activation has to resolve to 3 PM or the
   * accessible name is wrong in exactly the case where the user had no strong intent.
   * Playwright clicks element centres, so the test above IS the midpoint case and it
   * asserts 15:00 — this one proves the other half is reachable rather than the snapping
   * being decorative.
   */
  await page.goto('/?view=week')
  await settle(page)

  const slot = page.getByRole('button', { name: 'New event on 2026-05-19 at 3 PM' })
  const box = await slot.boundingBox()
  if (box === null) throw new Error('the 3 PM slot has no box to click in')
  // Three quarters down, which is unambiguously the lower half.
  await slot.click({ position: { x: box.width / 2, y: box.height * 0.75 } })

  const dialog = await settleSheet(page)
  await expect(dialog.getByLabel('Day')).toHaveValue('2026-05-19')
  await expect(dialog.getByLabel('Starts')).toHaveValue('15:30')
})

test('the sheet states when the event would end, and says so when it crosses midnight', async ({
  page,
}) => {
  /*
   * The form collected a start and a duration and never once said when the event would
   * END — the difference between describing an event and seeing one, and the source of the
   * commonest create-time mistake.
   */
  await page.goto('/?view=week')
  await settle(page)
  await page.getByRole('button', { name: 'New event on 2026-05-19 at 3 PM' }).click()
  const dialog = await settleSheet(page)

  await expect(dialog.getByText('15:00 \u2013 15:30')).toBeVisible()

  // A duration change moves it, which is the whole point of it being derived.
  await dialog.getByLabel('For').selectOption('120')
  await expect(dialog.getByText('15:00 \u2013 17:00')).toBeVisible()

  // Crossing midnight is the one surprise a derived end time can hold, so it is said in
  // words rather than left to a date the readout does not show.
  await dialog.getByLabel('Starts').fill('23:30')
  await expect(dialog.getByText('23:30 \u2013 01:30')).toBeVisible()
  await expect(dialog.getByText('ends the next day')).toBeVisible()
})

test('the day view inherits slot composing, and a later compose forgets the slot', async ({
  page,
}) => {
  await page.goto('/?view=day&date=2026-05-20')
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))

  await page.getByRole('button', { name: 'New event on 2026-05-20 at 8 AM' }).click()
  let dialog = await settleSheet(page)
  await expect(dialog.getByLabel('Day')).toHaveValue('2026-05-20')
  await expect(dialog.getByLabel('Starts')).toHaveValue('08:00')

  // Closing and composing from the plain button must not replay the clicked slot: the
  // button's contract is the anchor day at the default time.
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(sheet(page)).toHaveCount(0)
  await composeButton(page).click()
  dialog = await settleSheet(page)
  await expect(dialog.getByLabel('Starts')).toHaveValue('09:00')
})

test('a restricted audience gets no compose slots', async ({ page }) => {
  await page.goto('/?view=week&as=contact:sarah')
  await expect(page.getByRole('button', { name: /^New event on/ })).toHaveCount(0)
})

test('the compose sheet has no detectable WCAG A or AA violations', async ({ page }) => {
  await page.goto('/')
  await settle(page)

  await composeButton(page).click()
  await settleSheet(page)

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(
    results.violations.flatMap((v) => v.nodes.map((n) => `${v.id} @ ${n.target.join(' ')}`)),
  ).toEqual([])
})

test('gives every control in the compose sheet a 44px target', async ({ page }) => {
  await page.goto('/')
  await settle(page)
  await composeButton(page).click()
  await settleSheet(page)

  const undersized = await page.evaluate(() =>
    [...document.querySelectorAll('dialog button, dialog input, dialog select, dialog textarea')]
      .filter((el) => el.getBoundingClientRect().height < 44)
      .map((el) => el.getAttribute('id') ?? el.textContent?.trim() ?? el.tagName),
  )
  expect(undersized).toEqual([])
})

test('does not let anything typed into the demo leave the page', async ({ page, context }) => {
  // The compose form is the first place a user types plaintext that has never been
  // sealed. In demo mode nothing may be sent at all; the same canary discipline as the
  // edit sheet's leak test.
  const canary = 'Canary Compose Title 9c41'
  const sent: string[] = []
  page.on('request', (request) => {
    const body = request.postData()
    sent.push(request.url() + (body ?? ''))
  })

  await page.goto('/')
  await settle(page)
  await composeButton(page).click()
  const dialog = await settleSheet(page)

  await dialog.getByLabel('What is it').fill(canary)
  // Enter from a field is the implicit-submission path the demo guard exists for.
  await dialog.getByLabel('What is it').press('Enter')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(sheet(page)).toHaveCount(0)

  expect(sent.filter((entry) => entry.includes(canary))).toEqual([])

  const stored = await page.evaluate(
    () => JSON.stringify(localStorage) + JSON.stringify(sessionStorage),
  )
  expect(stored).not.toContain(canary)

  const cookies = await context.cookies()
  expect(cookies.some((cookie) => cookie.value.includes(canary))).toBe(false)
})
