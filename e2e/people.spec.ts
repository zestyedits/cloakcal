import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

/**
 * The People area — the register at /people and one file per contact. The load-bearing
 * assertions are still the privacy ones: the preview renders through the same redaction
 * the real visitor gets, so a restricted contact's file must show exactly what View As
 * shows — the sealed titles they are allowed, Busy where they are not, and an honest
 * count of what is withheld entirely.
 *
 * The register and file WRITE controls (add, rename, membership, level, remove) are
 * demo-gated under the fixture: they render honestly disabled with the demo sentence, so
 * structure and axe see them, and packages/db owns what the RPCs actually do. The live
 * write path needs a real account, which no automated run has — say so, never imply it.
 */

test('the sidebar links to People and the register names the demo contacts', async ({
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
  await expect(page.getByRole('heading', { level: 2, name: 'Contacts' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: 'Groups' })).toBeVisible()
  // FIXTURE AUDIENCES CARRY NO SEALED NAMES, deliberately, so the list shows the server's
  // honest fallback. Real-name decryption is exactly what the fixture cannot prove and
  // the live-account pass exists for — the defect class that once shipped unseen.
  await expect(page.getByText(/Contact sarah/)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('link', { name: /Contact sarah/ })).toHaveAttribute(
    'href',
    /\/people\/sarah/,
  )
})

test('the register offers the add controls, demo-gated with the honest sentence', async ({
  page,
}) => {
  await page.goto('/people')
  await expect(page.getByRole('heading', { level: 1, name: 'People' })).toBeVisible()

  // The controls exist — the register IS the contact book now — and the fixture disables
  // them rather than hiding them, so axe and this spec can see what real accounts get.
  await expect(page.getByRole('button', { name: 'Add contact' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Add group' })).toBeDisabled()
  await expect(page.getByText('Demo data. Sign in to manage people.')).toBeVisible()
})

test('a contact file is framed as a preview and shows their actual redaction', async ({
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

test('the file carries the whole person: preview, visibility, groups, removal', async ({
  page,
}) => {
  await page.goto('/people/sarah')
  await expect(page.getByRole('status')).toContainText(/This is what/)

  for (const name of ['What they see', 'Visibility', 'Groups', 'Remove']) {
    await expect(page.getByRole('heading', { level: 2, name })).toBeVisible()
  }

  // The level picker moved here from Settings, reading the same engine: Sarah's fixture
  // rule is limited, so that preset is the pressed one — and demo-disabled, honestly.
  const limited = page.getByRole('button', { name: 'Limited details' })
  await expect(limited).toHaveAttribute('aria-pressed', 'true')
  await expect(limited).toBeDisabled()
  // The engine's sentence, never hand-written copy.
  await expect(page.getByText(/They will/).first()).toBeVisible()

  await expect(page.getByText('Demo data. Sign in to change what people see.')).toBeVisible()
})

test('a group rule reads through to the member file', async ({ page }) => {
  // Alex has no individual rule; the colleagues group rule decides. The file's picker
  // must show Busy as pressed — this is groupsByContact reaching the engine, the exact
  // plumbing that once shipped empty for real accounts.
  await page.goto('/people/alex')
  await expect(page.getByRole('button', { name: 'Busy', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
})

test('a restricted audience sees Busy rows, never the words', async ({ page }) => {
  // Alex is busy-only via the colleagues group rule: times exist, content does not.
  await page.goto('/people/alex')
  await expect(page.getByText('Busy', { exact: true }).first()).toBeVisible({
    timeout: 15_000,
  })
  const content = await page.content()
  expect(content).not.toContain('Legal Call')
  expect(content).not.toContain('custody')
})

test('a contact that does not exist gets the 404 page, not an empty file', async ({
  page,
}) => {
  // Content, not status: a dynamic page streams its 200 before notFound() resolves, so
  // the status line cannot carry the answer. The page itself is the house 404, which
  // deliberately cannot distinguish "missing" from "not yours".
  await page.goto('/people/nobody-here')
  await expect(page.getByText('There is nothing here')).toBeVisible()
  await expect(page.getByText(/does not exist, or is not visible to you/)).toBeVisible()
  // And none of the file chrome leaked around it.
  await expect(page.getByRole('status')).toHaveCount(0)
})

test('the removal confirmation opens, warns, and cannot fire in the demo', async ({
  page,
}) => {
  // A control behind a click is a control nobody tested — the delete-confirmation lesson.
  await page.goto('/people/sarah')
  await page.getByRole('button', { name: 'Remove from your people' }).click()

  // Filtered because Next's route announcer is a second, empty role="alert".
  await expect(
    page.getByRole('alert').filter({ hasText: /removes any visibility rules/ }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: /Remove Contact sarah/ })).toBeDisabled()

  // The confirmation state scans clean too: the danger button is exactly the shape that
  // shipped a 2.99:1 label once.
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])

  // Keep collapses it.
  await page.getByRole('button', { name: 'Keep' }).click()
  await expect(page.getByRole('button', { name: 'Remove from your people' })).toBeVisible()
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

test('the people pages carry no em dash', async ({ page }) => {
  // The house decree, extended to the book: copy uses commas, colons and periods.
  for (const path of ['/people', '/people/sarah']) {
    await page.goto(path)
    await expect(page.getByRole('main')).toBeVisible()
    expect(await page.content()).not.toContain('—')
  }
})

test('gives every interactive control a 44px touch target', async ({ page }) => {
  for (const path of ['/people', '/people/sarah']) {
    await page.goto(path)
    await expect(page.getByRole('main')).toBeVisible()
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
      .map((m) => `${path} ${m.label}: ${m.height}px`)
    expect(tooSmall).toEqual([])
  }
})
