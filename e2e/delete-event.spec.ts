import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

/**
 * The delete confirmation, and its scope picker.
 *
 * Deleting had NO end-to-end coverage at all until now, which is backwards: it is the only
 * action on the calendar that a user cannot undo from the UI, and the only one where getting
 * the scope wrong destroys forty meetings instead of one.
 *
 * HONEST LIMIT: fixture mode has no writable backend, so nothing here actually deletes. What
 * is covered is everything up to the RPC — which question gets asked, which answer is
 * preselected, and that the answer cannot leak between rows. The writes themselves are
 * proven against real Postgres in packages/db/test/cancel-occurrence.test.ts and
 * trash-event.test.ts.
 *
 * `Team Standup` recurs Mon–Fri in the fixture; `Lunch with Sarah` happens once.
 */

const RECURRING = /Team Standup/
const ONE_OFF = /Lunch with Sarah/

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('Legal Call')).toBeVisible({ timeout: 15_000 })
})

/**
 * One event row.
 *
 * `ul > li`, not `li`. The agenda nests event rows inside a per-day list item, so a bare
 * `li` filtered by title matches the whole day as well as the event — and "first" then picks
 * the day, whose Delete buttons belong to other events.
 */
const rowFor = (page: Page, title: RegExp) =>
  page.locator('ul > li').filter({ hasText: title })

const triggerFor = (page: Page, title: RegExp) =>
  rowFor(page, title).first().getByRole('button', { name: /^Delete the/ })

/**
 * The confirmation, addressed by its label rather than by role alone: the scope fieldset is
 * also a group, so `getByRole('group')` is ambiguous inside an open confirmation.
 */
const confirmFor = (page: Page, title: RegExp) =>
  rowFor(page, title).first().getByRole('group', { name: /^Confirm deleting/ })

test('asks which occurrences to remove, for a repeating event', async ({ page }) => {
  await triggerFor(page, RECURRING).click()

  const confirm = confirmFor(page, RECURRING)
  await expect(confirm.getByRole('radio', { name: 'Only this one' })).toBeVisible()
  await expect(confirm.getByRole('radio', { name: 'The whole series' })).toBeVisible()
})

test('preselects the smaller blast radius', async ({ page }) => {
  // Not a style preference. Someone who clicks Delete on one Tuesday and then clicks the
  // confirm button without reading almost never meant every Tuesday, and this is the only
  // thing standing between that reflex and an unrecoverable deletion.
  await triggerFor(page, RECURRING).click()

  const confirm = confirmFor(page, RECURRING)
  await expect(confirm.getByRole('radio', { name: 'Only this one' })).toBeChecked()
  await expect(confirm.getByRole('radio', { name: 'The whole series' })).not.toBeChecked()
})

test('spells out the consequence, and changes it when the scope changes', async ({ page }) => {
  await triggerFor(page, RECURRING).click()
  const confirm = confirmFor(page, RECURRING)

  await expect(confirm).toContainText('The rest of the series stays')

  await confirm.getByRole('radio', { name: 'The whole series' }).check()
  // "Including ones that have already happened" is the part people are surprised by, so it
  // is stated rather than implied.
  await expect(confirm).toContainText('including ones that have already happened')
})

test('asks a plain question for an event that does not repeat', async ({ page }) => {
  // A scope picker here would be three controls offering one real choice.
  await triggerFor(page, ONE_OFF).click()

  const confirm = confirmFor(page, ONE_OFF)
  await expect(confirm).toContainText('Delete this event?')
  await expect(confirm.getByRole('radio')).toHaveCount(0)
})

test('keeps each row scope independent when several are open at once', async ({ page }) => {
  // The radio group is named per event+occurrence. A bare `name="scope"` would make every
  // open confirmation on the page one group, so choosing "the whole series" on Tuesday would
  // silently move Monday's selection too — and Monday's Delete button would then do
  // something the user never picked.
  const rows = rowFor(page, RECURRING)
  await rows.nth(0).getByRole('button', { name: /^Delete the/ }).click()
  await rows.nth(1).getByRole('button', { name: /^Delete the/ }).click()

  const second = rows.nth(1).getByRole('group', { name: /^Confirm deleting/ })
  await second.getByRole('radio', { name: 'The whole series' }).check()

  const first = rows.nth(0).getByRole('group', { name: /^Confirm deleting/ })
  await expect(first.getByRole('radio', { name: 'Only this one' })).toBeChecked()
})

test('Keep dismisses without deleting, and forgets the scope', async ({ page }) => {
  await triggerFor(page, RECURRING).click()
  const confirm = confirmFor(page, RECURRING)
  await confirm.getByRole('radio', { name: 'The whole series' }).check()
  await confirm.getByRole('button', { name: 'Keep' }).click()

  await expect(triggerFor(page, RECURRING)).toBeVisible()

  // Reopening must not carry the dangerous answer over from a confirmation the user backed
  // out of. Persisting it would mean a second Delete click did more than the first offered.
  await triggerFor(page, RECURRING).click()
  await expect(
    confirmFor(page, RECURRING).getByRole('radio', { name: 'Only this one' }),
  ).toBeChecked()
})

test('the open confirmation has no accessibility violations', async ({ page }) => {
  await triggerFor(page, RECURRING).click()
  await expect(confirmFor(page, RECURRING).getByRole('radio').first()).toBeVisible()

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()

  expect(results.violations).toEqual([])
})
