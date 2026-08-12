import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

/**
 * The Event Visibility sheet — a control behind a click, so it gets opened here (the
 * delete-confirmation lesson: axe only sees what is on screen).
 *
 * Under the dev fixture there is no session and no workspace, so the WRITE path is
 * disabled with honest copy and covered by packages/db's visibility-rules tests instead.
 * What e2e owns: the door opens, the audiences render with ENGINE copy, the tabs switch,
 * and the open sheet passes axe.
 */

const openSheet = async (page: import('@playwright/test').Page) => {
  await page.goto('/')
  await expect(page.getByText('Legal Call')).toBeVisible({ timeout: 15_000 })
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))

  await page
    .getByRole('button', { name: /Change who can see the event/ })
    .first()
    .click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Event visibility' })).toBeVisible()
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))
  return dialog
}

test('opens from the chip and explains each audience in the engine\'s words', async ({ page }) => {
  const dialog = await openSheet(page)

  // The four presets exist, labelled from PRIVACY_LEVELS.
  for (const label of ['Full details', 'Limited details', 'Busy', 'Hidden']) {
    await expect(dialog.getByRole('button', { name: label }).first()).toBeVisible()
  }

  // The summary is explainDecision output — "They will …" — never hand-written copy.
  await expect(dialog.getByText(/They will/).first()).toBeVisible()

  // Tabs switch between people and groups.
  await dialog.getByRole('tab', { name: 'Groups' }).click()
  await expect(dialog.getByRole('tab', { name: 'Groups' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
})

test('the open sheet has no accessibility violations', async ({ page }) => {
  await openSheet(page)
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])
})

test('closes on Escape and returns to the calendar', async ({ page }) => {
  const dialog = await openSheet(page)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText('Legal Call')).toBeVisible()
})
