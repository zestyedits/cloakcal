import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

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
const sheet = (page: import('@playwright/test').Page) => page.locator('dialog[open]')

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
async function openSheet(page: import('@playwright/test').Page, name: RegExp) {
  await page.getByRole('button', { name }).first().click()
  const dialog = sheet(page)
  await expect(dialog).toHaveCount(1)
  await dialog.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
  return dialog
}

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
  await expect(page.getByRole('button', { name: /— edit the event at/ })).toHaveCount(0)
})
