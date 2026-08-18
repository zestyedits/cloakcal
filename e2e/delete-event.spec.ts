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
 *
 * THE ROUTE IS THE EDIT SHEET. Delete used to sit permanently in every agenda row as well,
 * which was two doors to one room: the sheet has hosted this same component, with the same
 * two scopes and the same RPCs, since the sheet was built. The row's copy was removed
 * because the product's one irreversible action does not belong in the primary content area
 * once per row. Everything these tests assert is unchanged; only the way in is.
 */

const RECURRING = /Team Standup/
const ONE_OFF = /Lunch with Sarah/

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('Legal Call')).toBeVisible({ timeout: 15_000 })
})

type Dialog = ReturnType<Page['getByRole']>

/**
 * Open an event's sheet and return it.
 *
 * Waits out the rise rather than sleeping: the sheet animates over --duration-base, and axe
 * measures COMPOSITED colour, so analysing mid-animation reports every label as a contrast
 * failure against a box that is not painted yet.
 */
const openSheet = async (page: Page, title: RegExp): Promise<Dialog> => {
  await page.getByRole('button', { name: title }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toHaveCount(1)
  await dialog.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
  return dialog
}

/** The sheet's Delete trigger. */
const triggerIn = (dialog: Dialog) => dialog.getByRole('button', { name: /^Delete the/ })

/**
 * The confirmation, addressed by its label rather than by role alone: the scope fieldset is
 * also a group, so `getByRole('group')` is ambiguous inside an open confirmation.
 */
const confirmIn = (dialog: Dialog) =>
  dialog.getByRole('group', { name: /^Confirm deleting/ })

/** Open the sheet for `title` and click through to the confirmation. */
const confirmFor = async (page: Page, title: RegExp) => {
  const dialog = await openSheet(page, title)
  await triggerIn(dialog).click()
  return { dialog, confirm: confirmIn(dialog) }
}

test('asks which occurrences to remove, for a repeating event', async ({ page }) => {
  const { confirm } = await confirmFor(page, RECURRING)
  await expect(confirm.getByRole('radio', { name: 'Only this one' })).toBeVisible()
  await expect(confirm.getByRole('radio', { name: 'The whole series' })).toBeVisible()
})

test('the agenda row itself offers no delete, on any device', async ({ page }) => {
  // The removal, pinned. A permanent destructive control in every row of the primary
  // content area is what this change was about, and nothing else here would notice it
  // coming back, because every other test in the file now opens the sheet first.
  await expect(page.getByRole('button', { name: /^Delete the/ })).toHaveCount(0)
})

test('preselects the smaller blast radius', async ({ page }) => {
  // Not a style preference. Someone who clicks Delete on one Tuesday and then clicks the
  // confirm button without reading almost never meant every Tuesday, and this is the only
  // thing standing between that reflex and an unrecoverable deletion.
  const { confirm } = await confirmFor(page, RECURRING)
  await expect(confirm.getByRole('radio', { name: 'Only this one' })).toBeChecked()
  await expect(confirm.getByRole('radio', { name: 'The whole series' })).not.toBeChecked()
})

test('spells out the consequence, and changes it when the scope changes', async ({ page }) => {
  const { confirm } = await confirmFor(page, RECURRING)

  await expect(confirm).toContainText('The rest of the series stays')

  await confirm.getByRole('radio', { name: 'The whole series' }).check()
  // "Including ones that have already happened" is the part people are surprised by, so it
  // is stated rather than implied.
  await expect(confirm).toContainText('including ones that have already happened')
})

test('asks a plain question for an event that does not repeat', async ({ page }) => {
  // A scope picker here would be three controls offering one real choice.
  const { confirm } = await confirmFor(page, ONE_OFF)
  await expect(confirm).toContainText('Delete this event?')
  await expect(confirm.getByRole('radio')).toHaveCount(0)
})

test('scopes the radio group to one occurrence, not to the page', async ({ page }) => {
  /*
   * This used to open two confirmations at once and prove that choosing "the whole series"
   * on Tuesday left Monday alone. Two live confirmations are no longer REPRESENTABLE: the
   * only delete is inside a modal sheet, and one sheet closes before another opens. So the
   * old test would now pass by having nothing to compare rather than by the naming being
   * right, which is a green light with nothing behind it, in the one file that exists
   * because deleting cannot be undone.
   *
   * What survives is the property itself. The radio group is named per event AND
   * occurrence, so it can never be the page-wide `name="scope"` that caused the original
   * bug. Asserted on the name directly, rather than on the behaviour it used to produce.
   */
  const { confirm } = await confirmFor(page, RECURRING)
  const name = await confirm.getByRole('radio').first().getAttribute('name')

  expect(name).toBeTruthy()
  expect(name).not.toBe('scope')
  // Occurrence-qualified: a per-EVENT name would still collide across two occurrences of
  // one recurring series, which is exactly the Monday/Tuesday case.
  expect(name).toContain('2026-05-')
})

test('Keep dismisses without deleting, and forgets the scope', async ({ page }) => {
  const dialog = await openSheet(page, RECURRING)
  await triggerIn(dialog).click()
  const confirm = confirmIn(dialog)
  await confirm.getByRole('radio', { name: 'The whole series' }).check()
  await confirm.getByRole('button', { name: 'Keep' }).click()

  await expect(triggerIn(dialog)).toBeVisible()

  // Reopening must not carry the dangerous answer over from a confirmation the user backed
  // out of. Persisting it would mean a second Delete click did more than the first offered.
  await triggerIn(dialog).click()
  await expect(confirmIn(dialog).getByRole('radio', { name: 'Only this one' })).toBeChecked()
})

test('the open confirmation has no accessibility violations', async ({ page }) => {
  const { confirm } = await confirmFor(page, RECURRING)
  await expect(confirm.getByRole('radio').first()).toBeVisible()

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()

  expect(results.violations).toEqual([])
})
