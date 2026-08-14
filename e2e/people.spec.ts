import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

/**
 * The People area. The load-bearing assertions are the privacy ones: the preview renders
 * through the same redaction the real visitor gets, so a restricted contact's page must
 * show exactly what View As shows — the sealed titles they are allowed, Busy where they
 * are not, and an honest count of what is withheld entirely.
 */

test('the sidebar links to People and the list names the demo contacts', async ({
  page,
  isMobile,
}) => {
  await page.goto('/')
  await expect(page.getByText('Legal Call')).toBeVisible({ timeout: 15_000 })

  if (!isMobile) {
    await page.getByRole('link', { name: 'People' }).click()
    await expect(page).toHaveURL(/\/people$/)
  } else {
    await page.goto('/people')
  }

  await expect(page.getByRole('heading', { level: 1, name: 'People' })).toBeVisible()
  // FIXTURE AUDIENCES CARRY NO SEALED NAMES, deliberately, so the list shows the server's
  // honest fallback. Real-name decryption is exactly what the fixture cannot prove and
  // the live-account pass exists for — the defect class that once shipped unseen.
  await expect(page.getByText(/Contact sarah/)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('link', { name: /Contact sarah/ })).toHaveAttribute(
    'href',
    /\/people\/sarah/,
  )
})

test('a contact page is framed as a preview and shows their actual redaction', async ({
  page,
}) => {
  await page.goto('/people/sarah')

  // The banner is the frame: whose eyes, when, and the way out.
  await expect(page.getByRole('status')).toContainText(/This is what/)
  await expect(page.getByRole('link', { name: 'Exit preview' })).toHaveAttribute(
    'href',
    '/people',
  )

  // Sarah gets limited details in the fixture: titles yes, and the withheld count says
  // what she does not get. The numbers must agree with the View As note on `/`.
  await expect(page.getByText(/Sees \d+ of your \d+ events this week/)).toBeVisible({
    timeout: 15_000,
  })

  // The full-calendar link carries the same audience the page renders.
  await expect(
    page.getByRole('link', { name: /Open the full calendar as/ }),
  ).toHaveAttribute('href', /as=contact%3Asarah|as=contact:sarah/)
})

test('a restricted audience sees Busy rows, never the words', async ({ page }) => {
  // Alex is busy-only via the colleagues group rule: times exist, content does not.
  await page.goto('/people/alex')
  await expect(page.getByText('Busy').first()).toBeVisible({ timeout: 15_000 })
  const content = await page.content()
  expect(content).not.toContain('Legal Call')
  expect(content).not.toContain('custody')
})

test('a contact that does not exist gets the 404 page, not an empty preview', async ({
  page,
}) => {
  // Content, not status: a dynamic page streams its 200 before notFound() resolves, so
  // the status line cannot carry the answer. The page itself is the house 404, which
  // deliberately cannot distinguish "missing" from "not yours".
  await page.goto('/people/nobody-here')
  await expect(page.getByText('There is nothing here')).toBeVisible()
  await expect(page.getByText(/does not exist, or is not visible to you/)).toBeVisible()
  // And none of the preview chrome leaked around it.
  await expect(page.getByRole('status')).toHaveCount(0)
})

test('the people pages scan clean', async ({ page }) => {
  for (const path of ['/people', '/people/sarah']) {
    await page.goto(path)
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(results.violations.map((v) => `${path} ${v.id}: ${v.help}`)).toEqual([])
  }
})
