import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { openSheet, sheet } from './sheet'

/**
 * The edit sheet.
 *
 * This is the FIRST sheet any of these suites can open. `<NewEvent>` does not render in
 * fixture mode — `composeDate` is undefined there — so until now no automated check had ever
 * seen a dialog in this app, which is how a sheet claiming `aria-modal` with no focus trap
 * survived, and how white-on-accent sat below AA on the Save button.
 *
 * HONEST LIMIT: fixture mode has no writable backend, so nothing here saves. What is covered
 * is everything up to the RPC — that the sheet opens, pre-fills from DECRYPTED values,
 * refuses to offer what is not built, and never lets plaintext out of the page. The round
 * trip is proven against PGlite in packages/db/test/update-event.test.ts.
 */

const RECURRING = /Team Standup/
const ONE_OFF = /Lunch with Sarah/

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('Legal Call')).toBeVisible({ timeout: 15_000 })
})

/** The sheet, once open. Scoped because the agenda behind it has similarly-named controls. */

/**
 * Open a row's sheet and wait for it to finish animating.
 *
 * The wait is not padding. The sheet rises over `--duration-base`, and axe measures
 * COMPOSITED colour — so running it while the dialog is still at opacity 0 reports every
 * label in the form as a contrast failure against a box that is not there yet. That looked
 * exactly like a real palette bug for a while.
 *
 * Waiting on `getAnimations()` rather than sleeping a guessed number of milliseconds also
 * keeps this correct under prefers-reduced-motion, where the same animation collapses to
 * 1ms and a fixed sleep would just be wasted time.
 */
// The helper moved to ./sheet, where the reasoning above now lives in full.

test('opens from the event row and pre-fills from decrypted values', async ({ page }) => {
  const dialog = await openSheet(page, ONE_OFF)
  await expect(dialog.getByLabel('What is it')).toHaveValue('Lunch with Sarah')
  // Proves the pre-fill is reading the store rather than echoing the row: `location` is
  // never rendered in the agenda at all, so it can only have come from decryption.
  await expect(dialog.getByLabel('Where')).toHaveValue('Ivy Cafe')
})

test('pre-fills the timing from the occurrence, without rounding it', async ({ page }) => {
  const dialog = await openSheet(page, ONE_OFF)
  await expect(dialog.getByLabel('Day')).toHaveValue('2026-05-19')
  await expect(dialog.getByLabel('Starts')).toHaveValue('12:00')
  await expect(dialog.getByLabel('For')).toHaveValue('60')
})

test('keeps Save disabled until something actually changes', async ({ page }) => {
  // Not cosmetic: an empty save still bumps the row version, invalidating every other open
  // tab's optimistic guard for no reason.
  const dialog = await openSheet(page, ONE_OFF)
  const save = dialog.getByRole('button', { name: 'Save' })
  await expect(save).toBeDisabled()

  await dialog.getByLabel('What is it').fill('Lunch with Sarah, moved')
  await expect(save).toBeEnabled()
})

test('treats a whitespace-only edit as no edit', async ({ page }) => {
  const dialog = await openSheet(page, ONE_OFF)
  await dialog.getByLabel('What is it').fill('  Lunch with Sarah  ')
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled()
})

test('asks a repeating event which occurrences to change', async ({ page }) => {
  const dialog = await openSheet(page, RECURRING)
  for (const choice of ['Only this event', 'This and all following', 'All events']) {
    await expect(dialog.getByRole('radio', { name: choice })).toBeVisible()
  }
  // Least destructive by default, which is also what every other calendar does.
  await expect(dialog.getByRole('radio', { name: 'Only this event' })).toBeChecked()
  await expect(dialog.getByLabel('What is it')).toHaveValue('Team Standup')
})

test('says what each scope will do, in words', async ({ page }) => {
  // The sentence that stops somebody changing forty meetings when they meant one. The
  // already-happened clause is the part people are surprised by, so it is asserted.
  const dialog = await openSheet(page, RECURRING)
  await expect(dialog.getByText(/Just this occurrence changes/)).toBeVisible()

  await dialog.getByRole('radio', { name: 'This and all following' }).check()
  await expect(dialog.getByText(/every one after it changes/)).toBeVisible()

  await dialog.getByRole('radio', { name: 'All events' }).check()
  await expect(dialog.getByText(/including ones that have already happened/)).toBeVisible()
})

test('offers timing on a split scope, and withdraws it for the whole series', async ({ page }) => {
  // Retiming a whole series would move the anchor and strand every exception on the old wall
  // time, so the RPC refuses it — the form must not offer what the server will reject.
  const dialog = await openSheet(page, RECURRING)
  await expect(dialog.getByLabel('Day')).toBeVisible()

  await dialog.getByRole('radio', { name: 'All events' }).check()
  await expect(dialog.getByLabel('Day')).toHaveCount(0)
  await expect(dialog.getByText(/time cannot be changed for the whole series/)).toBeVisible()
})

test('discards changes when cancelled', async ({ page }) => {
  await openSheet(page, ONE_OFF)
  await sheet(page).getByLabel('What is it').fill('something else entirely')
  await sheet(page).getByRole('button', { name: 'Cancel' }).click()

  await expect(sheet(page)).toHaveCount(0)
  await page.getByRole('button', { name: ONE_OFF }).first().click()
  await expect(sheet(page).getByLabel('What is it')).toHaveValue('Lunch with Sarah')
})

test('is a real modal, and Escape returns focus to the row', async ({ page }) => {
  const row = page.getByRole('button', { name: ONE_OFF }).first()
  await openSheet(page, ONE_OFF)
  // `:modal` is only true in the top layer, which is what actually provides the focus trap
  // and the inertness of the page behind. The previous markup claimed both and had neither.
  expect(await page.evaluate(() => document.querySelector('dialog')?.matches(':modal'))).toBe(true)

  await page.keyboard.press('Escape')
  await expect(sheet(page)).toHaveCount(0)
  await expect(row).toBeFocused()
})

test('has no detectable WCAG A or AA violations while open', async ({ page }) => {
  await openSheet(page, ONE_OFF)

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()

  // Reports the offending SELECTOR, not just the rule id. "color-contrast failed" sends you
  // hunting; "color-contrast on button.save" does not.
  expect(
    results.violations.flatMap((v) => v.nodes.map((n) => `${v.id} @ ${n.target.join(' ')}`)),
  ).toEqual([])
})

test('gives every control in the sheet a 44px target', async ({ page }) => {
  await openSheet(page, ONE_OFF)

  const undersized = await page.evaluate(() =>
    [...document.querySelectorAll('dialog button, dialog input, dialog select, dialog textarea')]
      .filter((el) => el.getBoundingClientRect().height < 44)
      .map((el) => el.getAttribute('id') ?? el.textContent?.trim() ?? el.tagName),
  )
  expect(undersized).toEqual([])
})

test('does not let a form value carry plaintext out of the page', async ({ page, context }) => {
  // A form `value` is a different serialization surface from a text node, and this is the
  // first place decrypted content sits in one. The existing leak suite only ever saw the
  // agenda's rendered text.
  const canaries = ['Lunch with Sarah', 'Ivy Cafe']
  const sent: string[] = []
  page.on('request', (request) => {
    const body = request.postData()
    sent.push(request.url() + (body ?? ''))
  })

  await openSheet(page, ONE_OFF)

  expect(sent.filter((entry) => canaries.some((c) => entry.includes(c)))).toEqual([])

  const stored = await page.evaluate(() => JSON.stringify(localStorage) + JSON.stringify(sessionStorage))
  for (const canary of canaries) expect(stored).not.toContain(canary)

  const cookies = await context.cookies()
  for (const canary of canaries) {
    expect(cookies.some((cookie) => cookie.value.includes(canary))).toBe(false)
  }
})

test('shows no edit affordance to an audience that is not the owner', async ({ page }) => {
  await page.goto('/?as=contact%3Asarah')
  await expect(page.getByRole('button', { name: /, edit the event at/ })).toHaveCount(0)
})

test('offers custom minutes behind the duration presets', async ({ page }) => {
  const dialog = await openSheet(page, ONE_OFF)
  const duration = dialog.getByLabel('For')

  // The presets stay the fast path; Custom is the escape hatch for everything between them.
  await duration.selectOption('custom')
  const minutes = dialog.getByLabel('Minutes')
  await expect(minutes).toBeVisible()
  // Seeded from the event's own duration, so opening custom mode changes nothing by itself.
  await expect(minutes).toHaveValue('60')
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled()

  await minutes.fill('25')
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeEnabled()

  // Picking a preset again puts the number input away rather than leaving two controls
  // arguing over one value.
  await duration.selectOption('30')
  await expect(dialog.getByLabel('Minutes')).toHaveCount(0)
})

/*
 * Delete, inside the sheet. Day and Week open this sheet and Month drills to Day, so
 * before this the agenda was the only view an event could be deleted from — which is what
 * Keith hit in Day view. The confirmation is the same DeleteEvent flow the agenda rows
 * carry (delete-event.spec.ts covers its scope semantics exhaustively); these tests pin
 * that it exists in the sheet, asks the same questions, and scans clean — a control
 * behind a click is a control nobody tested until a spec opens it.
 */

test('carries a Delete action, behind the same two-scope confirmation', async ({ page }) => {
  const dialog = await openSheet(page, RECURRING)
  await dialog.getByRole('button', { name: /^Delete the/ }).click()

  const confirm = dialog.getByRole('group', { name: /^Confirm deleting/ })
  await expect(confirm.getByRole('radio', { name: 'Only this one' })).toBeChecked()
  await expect(confirm.getByRole('radio', { name: 'The whole series' })).not.toBeChecked()
  // The consequence copy rides along, unchanged from the agenda's confirmation.
  await expect(confirm).toContainText('The rest of the series stays')
})

test('asks a one-off event the plain delete question', async ({ page }) => {
  const dialog = await openSheet(page, ONE_OFF)
  await dialog.getByRole('button', { name: /^Delete the/ }).click()

  const confirm = dialog.getByRole('group', { name: /^Confirm deleting/ })
  await expect(confirm).toContainText('Delete this event?')
  await expect(confirm.getByRole('radio')).toHaveCount(0)
})

test('Keep backs out of the delete and returns to the edit form intact', async ({ page }) => {
  const dialog = await openSheet(page, ONE_OFF)
  await dialog.getByLabel('What is it').fill('still being edited')
  await dialog.getByRole('button', { name: /^Delete the/ }).click()
  await dialog.getByRole('button', { name: 'Keep' }).click()

  // The sheet survives the detour and so does the typing.
  await expect(dialog.getByRole('button', { name: /^Delete the/ })).toBeVisible()
  await expect(dialog.getByLabel('What is it')).toHaveValue('still being edited')
})

test('the open delete confirmation in the sheet has no accessibility violations', async ({
  page,
}) => {
  const dialog = await openSheet(page, RECURRING)
  await dialog.getByRole('button', { name: /^Delete the/ }).click()
  await expect(
    dialog.getByRole('group', { name: /^Confirm deleting/ }).getByRole('radio').first(),
  ).toBeVisible()

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(
    results.violations.flatMap((v) => v.nodes.map((n) => `${v.id} @ ${n.target.join(' ')}`)),
  ).toEqual([])
})
