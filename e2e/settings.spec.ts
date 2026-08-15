import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

/**
 * /settings under the dev fixture: no workspace and no session, so everything needing a
 * row to write to renders disabled with honest copy. That split is deliberate and mirrors
 * the CRUD suite — e2e owns structure, headings, targets and honesty; the db tests own what
 * the RPCs actually do. A fixture that could mutate real data would prove less, not more.
 *
 * The four DISPLAY preferences are the exception, and it is not a weakening. They now write
 * to a cookie (lib/demo-prefs.ts), so the demo can show them working without touching an
 * account. The rule the old assertions were protecting — never render a control that does
 * nothing — is better served by a control that does something than by a grey one.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/settings')
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
})

test('every section is present, anchored, and in the stated order', async ({ page }) => {
  const sections = ['Appearance', 'Time & region', 'Calendars', 'People', 'Visibility', 'Security', 'Coming soon']
  for (const name of sections) {
    // The h2 lives in the summary row, so it stays visible while the card is closed.
    await expect(page.getByRole('heading', { level: 2, name })).toBeVisible()
  }
  // The nav chip navigates to its anchor AND opens the card it points at — a deep link
  // that lands on a closed row would be a link that appears to do nothing.
  await page.getByRole('link', { name: 'Security' }).click()
  await expect(page).toHaveURL(/#security$/)
  await expect(page.locator('#security')).toHaveAttribute('open', '')
})

test('sections are closed by default with their state on the row', async ({ page }) => {
  // The page reads as a table of contents: only Appearance opens by default, and every
  // closed row still says what its current value is.
  await expect(page.locator('#appearance')).toHaveAttribute('open', '')
  for (const id of ['time-region', 'calendars', 'people', 'visibility', 'security', 'more']) {
    await expect(page.locator(`#${id}`)).not.toHaveAttribute('open', '')
  }
  await expect(page.getByText('Password & recovery phrase')).toBeVisible()

  // Clicking a summary opens the card.
  await page.getByRole('heading', { level: 2, name: 'Calendars' }).click()
  await expect(page.locator('#calendars')).toHaveAttribute('open', '')
})

test('demo display preferences work, and say where they are kept', async ({ page }) => {
  await page.getByRole('heading', { level: 2, name: 'Time & region' }).click()
  await expect(page.getByText(/kept in this browser only/)).toBeVisible()

  for (const label of ['Timezone', 'Week starts on', 'Default view', 'Keyboard shortcuts']) {
    await expect(page.getByLabel(label)).toBeEnabled()
  }

  // The demo models a user who OPTED IN to single-key shortcuts, which is why the hotkey
  // suite has a live keyboard to test. It is not the product default: WCAG 2.1.4 wants
  // those off until asked for, and that default is pinned where it lives, on the 0022
  // column and its db test, rather than being inferred from a fixture.
  await expect(page.getByLabel('Keyboard shortcuts')).toHaveValue('on')

  // The one that matters most, end to end: choose it, reload, it is still chosen. A
  // preference that forgets on refresh is worse than one that is disabled, because it
  // looks like it worked.
  await page.getByLabel('Default view').selectOption('month')
  await page.reload()
  await page.getByRole('heading', { level: 2, name: 'Time & region' }).click()
  await expect(page.getByLabel('Default view')).toHaveValue('month')
})

test('sections with no demo write path stay honestly disabled', async ({ page }) => {
  // Everything that would touch real rows is still inert, with a sentence rather than a
  // spinner or a silent no-op. Only display preferences got a demo destination.
  await page.getByRole('heading', { level: 2, name: 'Calendars' }).click()
  await expect(page.getByText(/Demo data\. Sign in/).first()).toBeVisible()
})

test('the People card is a signpost into the book, not a second manager', async ({ page }) => {
  // The contact manager moved to /people; a copy left behind would drift. The card now
  // points across, and none of the old write controls exist here.
  await page.getByRole('heading', { level: 2, name: 'People' }).click()
  await expect(page.getByRole('link', { name: 'Open People' })).toHaveAttribute(
    'href',
    '/people',
  )
  await expect(page.getByRole('button', { name: 'Add contact' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Add group' })).toHaveCount(0)
})

test('the Visibility card names where per-person rules went', async ({ page }) => {
  // Fixture settings has no workspace, so the card shows the honest demo sentence; the
  // lede still tells the truth about the split (link and groups here, people in files).
  await page.getByRole('heading', { level: 2, name: 'Visibility' }).click()
  await expect(page.getByText(/Rules for a person live in their file/)).toBeVisible()
  await expect(page.getByText('Demo data. Sign in to set visibility.')).toBeVisible()
})

test('the theme radios switch the page and persist across reload', async ({ page }) => {
  const light = page.getByRole('radio', { name: 'Light' })
  await light.check()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  // Back to the default so later tests and screenshots see dark.
  await page.getByRole('radio', { name: /Dark/ }).check()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})

test('the deferred rows are named and quiet', async ({ page }) => {
  await page.getByRole('heading', { level: 2, name: 'Coming soon' }).click()
  for (const name of ['Device pairing', 'Booking', 'Export']) {
    await expect(page.getByText(name, { exact: true })).toBeVisible()
  }
})

test('has no detectable WCAG A or AA violations', async ({ page }) => {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])
})

test('gives every interactive control a 44px touch target', async ({ page }) => {
  const measured = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button, a[href]')).map((el) => ({
      label: (el.textContent ?? '').trim().slice(0, 30) || el.tagName,
      height: Math.round(el.getBoundingClientRect().height),
      hidden: el.getBoundingClientRect().height === 0,
    })),
  )
  expect(measured.length).toBeGreaterThan(0)
  const tooSmall = measured
    .filter((m) => !m.hidden)
    .filter((m) => m.height < 44)
    .map((m) => `${m.label}: ${m.height}px`)
  expect(tooSmall).toEqual([])
})

test('keeps every heading in a sensible order', async ({ page }) => {
  const levels = await page.evaluate(() =>
    Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) => Number(h.tagName.slice(1))),
  )
  expect(levels.length).toBeGreaterThan(0)
  for (let i = 1; i < levels.length; i += 1) {
    expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(1)
  }
})
