import { expect, test } from '@playwright/test'

/**
 * View As, end to end.
 *
 * Spec §4 calls this a trust feature, so these assert that switching audience genuinely
 * changes what the SERVER sends — not what the client chooses to draw. The check that
 * matters is the last one: content withheld from an audience must be absent from the HTML
 * and the Flight payload, not merely hidden by CSS.
 */

const CANARIES = [
  'Legal Call',
  'Lunch with Sarah',
  'Bramblewick handover',
  'Quarrystone Room',
  'Marchpane clause',
]

test('the owner sees full detail', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('Legal Call')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Bramblewick handover')).toBeVisible()
})

test('a client sees titles only for events shared with them', async ({ page }) => {
  await page.goto('/?as=contact:sarah')
  // Sarah has an individual rule: exact time, title visible.
  await expect(page.getByText('Legal Call')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('combobox', { name: /viewing as/i })).toHaveValue('contact:sarah')
})

test('a colleague sees busy blocks with no content at all', async ({ page }) => {
  await page.goto('/?as=contact:alex')
  await expect(page.getByText('Busy').first()).toBeVisible({ timeout: 15_000 })

  // The strongest assertion available: the withheld titles are not in the document, so
  // they were never sent — no CSS trick could produce this.
  const html = await page.content()
  expect(CANARIES.filter((c) => html.includes(c))).toEqual([])
})

test('the public sees nothing, and is told so plainly', async ({ page }) => {
  await page.goto('/?as=public')

  // No number, by decision (2026-08-18) — see preview-bar.tsx. What must survive is that
  // the three empty states stay tellable apart by WORDING, which is now the only thing
  // separating "this audience sees nothing" from "this week is empty".
  // A HEADING now, not a sentence, so no terminal period — the empty state was rebuilt from
  // one centred line into a title, a lede and (for the owner) the way in. Matched by role so
  // this asserts the structure as well as the words.
  await expect(
    page.getByRole('heading', { name: 'Nothing here for this audience' }),
  ).toBeVisible({ timeout: 15_000 })

  const html = await page.content()
  expect(CANARIES.filter((c) => html.includes(c))).toEqual([])
})

test('a busy audience is not shown the calendar list', async ({ page }) => {
  // Calendar membership groups events, and grouping is itself a disclosure.
  await page.goto('/?as=contact:alex')
  await expect(page.getByText('Busy').first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('heading', { name: /my calendars/i })).toHaveCount(0)
})

test('no preview surface puts a number on what it is hiding', async ({ page }) => {
  /*
   * The inverse of the test that used to live here, and the reason is a decision rather
   * than a discovery: the withheld count was removed from every preview surface on
   * 2026-08-18.
   *
   * It is asserted as an ABSENCE across the whole page because that is what the decision
   * is. The count previously appeared in two places at once (the View As note and the
   * empty state), so a check scoped to one of them would go green while the other kept
   * counting.
   */
  await page.goto('/?as=public')
  // A HEADING now, not a sentence, so no terminal period — the empty state was rebuilt from
  // one centred line into a title, a lede and (for the owner) the way in. Matched by role so
  // this asserts the structure as well as the words.
  await expect(
    page.getByRole('heading', { name: 'Nothing here for this audience' }),
  ).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/hidden from them entirely/i)).toHaveCount(0)
  await expect(page.getByText(/\d+ events? (is|are) hidden/i)).toHaveCount(0)
})

test('previewing announces itself at the top of the content, with a way out', async ({
  page,
}) => {
  // The mode used to be announced only by an accent border on a sidebar card: 300px from
  // the content on desktop, and above the fold only until you scrolled on a phone.
  await page.goto('/?as=contact:sarah')
  const bar = page.getByText('Previewing as')
  await expect(bar).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: 'Back to my view' }).click()
  // The SAME 15s budget every other first-paint assertion in this file carries. Leaving
  // these on the default 5s made the test flaky under parallel load and it failed on a
  // different project each run: the click crosses a router.push server navigation, so the
  // assertions are waiting on a round trip, not on a re-render.
  await expect(page.getByText('Previewing as')).toHaveCount(0, { timeout: 15_000 })
  // Back to the owner's own calendar, not merely a cleared banner.
  await expect(page.getByRole('combobox', { name: /viewing as/i })).toHaveValue('owner', {
    timeout: 15_000,
  })
})

test('the owner is never shown a preview bar', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('Legal Call')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Previewing as')).toHaveCount(0)
})

test('server responses for a restricted audience carry no withheld ciphertext', async ({ page }) => {
  // The server must not ship sealed fields the audience cannot open — holding ciphertext
  // back is the whole point of redaction, not just hiding the plaintext.
  const bodies: string[] = []
  page.on('response', async (response) => {
    if (['document', 'fetch'].includes(response.request().resourceType())) {
      bodies.push(await response.text().catch(() => ''))
    }
  })

  await page.goto('/?as=contact:alex')
  await expect(page.getByText('Busy').first()).toBeVisible({ timeout: 15_000 })

  const combined = bodies.join('\n')
  expect(combined).not.toContain('aes-256-gcm-v1')
})

test('the owner response does carry ciphertext, proving the previous test is not vacuous', async ({
  page,
}) => {
  const bodies: string[] = []
  page.on('response', async (response) => {
    if (response.request().resourceType() === 'document') {
      bodies.push(await response.text().catch(() => ''))
    }
  })

  await page.goto('/')
  await expect(page.getByText('Legal Call')).toBeVisible({ timeout: 15_000 })
  expect(bodies.join('\n')).toContain('aes-256-gcm-v1')
})

/**
 * The Cloak sheet as the second door into preview.
 *
 * It used to contain a copy of the sidebar's picker; the rows carry the action now, so
 * these assert the door still opens and, more importantly, that it closes again — a sheet
 * that could take you into someone else's view and not out of it would be a trap.
 */

test('the Cloak sheet previews from a row and offers the way back', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('Legal Call')).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: 'Cloak', exact: true }).filter({ visible: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()

  await dialog.getByRole('button', { name: /^View as / }).first().click()
  await expect(page).toHaveURL(/as=/)
  // The sheet closes on its way out: it is a modal over the page that just changed
  // underneath it, and leaving it up would cover the answer.
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // The sidebar bar is where the resulting MODE is visible, which is why it stayed.
  await expect(page.getByRole('combobox', { name: /viewing as/i })).not.toHaveValue('owner')

  await page.getByRole('button', { name: 'Cloak', exact: true }).filter({ visible: true }).click()
  await page.getByRole('button', { name: 'Back to my own view' }).click()
  await expect(page).not.toHaveURL(/as=/)
})

/*
 * The privacy chip means "this one is different", and that is only true if it is absent
 * where nothing is different.
 *
 * Before this rule the chip showed the widest disclosure unless it was `full` — and the
 * widest disclosure is a workspace setting, so one contact on title-only printed "Limited
 * details" on all eleven fixture rows. Eleven copies of one fact, each costing the eye a
 * stop. The failure mode being guarded here is the return of that: a chip on every row
 * again, or a chip on none, both of which look fine in a screenshot.
 */
test('the agenda chips only the event that departs from the baseline', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('Legal Call')).toBeVisible({ timeout: 15_000 })

  // The agenda list, not the first list on the page: the mini month and the calendars
  // list are both lists and both sit above it in the DOM.
  const agenda = page.locator('main ol').first()

  // Project Review carries event-scoped rules hiding it from everyone who could otherwise
  // see something (see FIXTURE_EVENT_RULES). It is the only row that may wear a chip.
  await expect(agenda.getByText('Hidden', { exact: true })).toHaveCount(1)

  // And the baseline is stated once, in the same words, rather than on every row. Scoped
  // to the sidebar, because a page-wide `Limited details` would also match a visibility
  // control on some other surface, and a negative assertion that matches the whole page is
  // asserting about the whole page.
  const sidebar = page.getByRole('complementary', { name: 'Calendars' })
  await expect(sidebar.getByText('By default, others see')).toBeVisible()
  await expect(sidebar.getByText('Limited details', { exact: true })).toHaveCount(1)
  await expect(agenda.getByText('Limited details', { exact: true })).toHaveCount(0)

  // Rows at the baseline say something useful instead of saying nothing: the calendar.
  await expect(agenda.getByText('Work', { exact: true }).first()).toBeVisible()
})
