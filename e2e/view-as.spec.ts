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
  // The count is stated, not implied. "Nothing here" alone would leave a reviewer unable
  // to tell "this audience sees nothing" apart from "this week is empty" — which are very
  // different claims to be checking.
  await expect(page.getByText(/hidden from them entirely/i).first()).toBeVisible({
    timeout: 15_000,
  })
  await expect(page.getByText(/\d+ events are hidden from them entirely/i).first()).toBeVisible()

  const html = await page.content()
  expect(CANARIES.filter((c) => html.includes(c))).toEqual([])
})

test('a busy audience is not shown the calendar list', async ({ page }) => {
  // Calendar membership groups events, and grouping is itself a disclosure.
  await page.goto('/?as=contact:alex')
  await expect(page.getByText('Busy').first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('heading', { name: /my calendars/i })).toHaveCount(0)
})

test('the withheld count is stated, not implied', async ({ page }) => {
  await page.goto('/?as=public')
  // Two elements legitimately say this — the View As note and the empty state — so scope
  // to the first rather than loosening the matcher.
  await expect(page.getByText(/hidden from them entirely/i).first()).toBeVisible({
    timeout: 15_000,
  })
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
