import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

/**
 * Keyboard navigation. Every binding, plus the two guards that make single-key
 * shortcuts acceptable at all: keys typed into a field belong to the field, and keys
 * pressed while any dialog is open belong to the dialog.
 */

const settle = async (page: import('@playwright/test').Page) => {
  await expect(page.getByText('Legal Call')).toBeVisible({ timeout: 15_000 })
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))
}

test('t returns to today and keeps the view', async ({ page }) => {
  await page.goto('/?view=day&date=2026-05-19')
  await page.keyboard.press('t')
  await expect(page).toHaveURL(/view=day/)
  await expect(page).not.toHaveURL(/date=/)
})

test('arrows and j/k step the anchor by the view unit', async ({ page }) => {
  await page.goto('/?view=day&date=2026-05-19')
  await page.keyboard.press('ArrowRight')
  await expect(page).toHaveURL(/date=2026-05-20/)
  await page.keyboard.press('j')
  await expect(page).toHaveURL(/date=2026-05-21/)
  await page.keyboard.press('k')
  await expect(page).toHaveURL(/date=2026-05-20/)
})

test('number keys switch views, staying instant on the week fetch', async ({ page }) => {
  await page.goto('/')
  await settle(page)

  await page.keyboard.press('4')
  await expect(page).toHaveURL(/view=month/)

  await page.goto('/')
  await settle(page)
  // 2 is the client toggle over the shared fetch: the Week control activates and the
  // URL does not change, exactly like clicking it.
  await page.keyboard.press('2')
  const week = page
    .getByRole('navigation', { name: 'Calendar views' })
    .first()
    .getByRole('button', { name: 'Week', exact: true })
  await expect(week).toHaveAttribute('aria-current', 'page')
  await expect(page).not.toHaveURL(/view=/)

  await page.keyboard.press('3')
  await expect(page).toHaveURL(/view=day/)
})

test('the audience survives a keyboard step', async ({ page }) => {
  await page.goto('/?view=day&date=2026-05-19&as=contact:alex')
  await page.keyboard.press('ArrowRight')
  await expect(page).toHaveURL(/as=contact/)
  await expect(page).toHaveURL(/date=2026-05-20/)
})

test('keys typed into a field belong to the field', async ({ page }) => {
  await page.goto('/')
  await settle(page)

  await page.getByRole('button', { name: 'Lunch with Sarah' }).click()
  const dialog = page.locator('dialog[open]')
  await expect(dialog).toBeVisible()
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))

  const title = dialog.getByLabel('What is it')
  await title.click()
  await title.press('End')
  await title.press('t')
  await expect(title).toHaveValue(/t$/)
  await expect(page).not.toHaveURL(/view=/)
})

test('an open dialog silences navigation keys even with no field focused', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'the Cloak sheet opens from desktop chrome in this test')
  await page.goto('/')
  await settle(page)

  await page.getByRole('button', { name: 'Cloak', exact: true }).filter({ visible: true }).click()
  await expect(page.locator('dialog[open]')).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(page).not.toHaveURL(/date=/)
  await page.keyboard.press('Escape')
  await expect(page.locator('dialog[open]')).toHaveCount(0)
})

test('? opens the shortcut help, which scans clean and closes on Escape', async ({ page }) => {
  await page.goto('/')
  await settle(page)

  await page.keyboard.press('?')
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(help).toBeVisible()
  await expect(help.getByText('Shortcuts are ignored while you are typing.')).toBeVisible()

  // A control behind a keypress is still a control nobody tested unless a spec opens it.
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])

  await page.keyboard.press('Escape')
  await expect(help).toHaveCount(0)
})

test('n is inert in fixture mode, like the disabled compose button', async ({ page }) => {
  await page.goto('/')
  await settle(page)
  await page.keyboard.press('n')
  await page.waitForTimeout(300)
  await expect(page.locator('dialog[open]')).toHaveCount(0)
})
