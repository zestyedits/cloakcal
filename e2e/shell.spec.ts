import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

/**
 * The shell: five-item nav with Cloak in the centre, the Today link, the mobile week
 * strip, the sidebar compose button and mini month. Controls that appear on interaction
 * (the Cloak sheet) get opened and scanned here, because a control behind a click is a
 * control nobody tested — the delete-confirmation lesson.
 */

const settle = async (page: import('@playwright/test').Page) => {
  await expect(page.getByText('Legal Call')).toBeVisible({ timeout: 15_000 })
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))
}

test('the bottom nav has five slots with Cloak in the centre', async ({ page }) => {
  await page.goto('/')
  await settle(page)

  const nav = page.getByRole('navigation', { name: 'Calendar views' })
  const labels = await nav.locator('button').allTextContents()
  expect(labels).toEqual(['Day', 'Week', 'Cloak', 'Agenda', 'Month'])

  // The four view switches keep their exact semantics.
  await expect(nav.getByRole('button', { name: 'Day', exact: true })).toBeDisabled()
  await expect(nav.getByRole('button', { name: 'Month', exact: true })).toBeDisabled()
  await expect(nav.getByRole('button', { name: 'Week', exact: true })).toBeEnabled()
  await expect(nav.getByRole('button', { name: 'Agenda', exact: true })).toBeEnabled()
})

test('the Cloak sheet opens, says who sees what, and passes axe', async ({ page }) => {
  await page.goto('/')
  await settle(page)

  await page.getByRole('button', { name: 'Cloak', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Cloak' })).toBeVisible()
  await expect(dialog.getByText('Viewing as')).toBeVisible()
  // The fixture's restricted audiences appear with engine copy, not restated prose.
  await expect(dialog.getByText(/They will/).first()).toBeVisible()

  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

test('Today is a link home that keeps the audience', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Today is tablet-and-up chrome; the week strip owns "now" on phones')
  await page.goto('/?as=contact:alex')
  await expect(page.getByRole('link', { name: 'Today' })).toHaveAttribute(
    'href',
    /as=contact%3Aalex|as=contact:alex/,
  )
})

test('the week strip jumps to a day', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the strip is mobile chrome; the mini month covers desktop')
  await page.goto('/')
  await settle(page)

  const strip = page.getByRole('navigation', { name: 'Jump to a day' })
  await expect(strip.locator('a')).toHaveCount(7)
  await strip.locator('a').nth(2).click()
  await expect(page).toHaveURL(/#day-\d{4}-\d{2}-\d{2}$/)
})

test('the sidebar mini month navigates by week', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the mini month is desktop chrome; the strip covers mobile')
  await page.goto('/')
  await settle(page)

  const month = page.getByRole('navigation', { name: 'Jump to a week' })
  await expect(month.locator('a')).toHaveCount(42)
  await month.locator('a').first().click()
  await expect(page).toHaveURL(/week=\d{4}-\d{2}-\d{2}/)
})
