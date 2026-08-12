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

test('the bottom nav has five slots with Cloak in the centre', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the bottom bar is phone chrome; desktop has the header control')
  await page.goto('/')
  await settle(page)

  const nav = page.getByRole('navigation', { name: 'Calendar views' })
  const labels = await nav.locator('button, a').allTextContents()
  expect(labels).toEqual(['Day', 'Week', 'Cloak', 'Agenda', 'Month'])

  // Agenda/Week are instant toggles over the shared fetch; Day/Month are navigations.
  await expect(nav.getByRole('link', { name: 'Day', exact: true })).toHaveAttribute(
    'href',
    /view=day/,
  )
  await expect(nav.getByRole('link', { name: 'Month', exact: true })).toHaveAttribute(
    'href',
    /view=month/,
  )
  await expect(nav.getByRole('button', { name: 'Week', exact: true })).toBeEnabled()
  await expect(nav.getByRole('button', { name: 'Agenda', exact: true })).toBeEnabled()
})

test('desktop gets the segmented view control instead of the phone bar', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'the segmented control is desktop chrome')
  await page.goto('/')
  await settle(page)

  // Two navs exist with this name; the phone bar is display:none here, so the visible
  // one is the header's segmented control.
  const controls = page.getByRole('navigation', { name: 'Calendar views' })
  const header = controls.first()
  await expect(header).toBeVisible()
  await expect(controls.nth(1)).toBeHidden()

  await expect(header.getByRole('button', { name: 'Agenda', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  )
  await expect(header.getByRole('link', { name: 'Month', exact: true })).toBeVisible()
  // The compact Cloak door lives beside it.
  await expect(page.getByRole('button', { name: 'Cloak', exact: true }).filter({ visible: true })).toBeVisible()
})

test('the Cloak sheet opens, says who sees what, and passes axe', async ({ page }) => {
  await page.goto('/')
  await settle(page)

  await page.getByRole('button', { name: 'Cloak', exact: true }).filter({ visible: true }).click()
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
  await expect(page).toHaveURL(/date=\d{4}-\d{2}-\d{2}/)
})
