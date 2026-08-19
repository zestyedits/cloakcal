import { expect, test } from '@playwright/test'

/**
 * Export to .ics.
 *
 * This is the first place the product hands the user their own PLAINTEXT, so the interesting
 * assertions are not "a file appeared" but what is in it and where it went. The file is
 * assembled in the browser from decrypted content, which is exactly what the privacy policy
 * claims, and `legal-claims.server.test.ts` fails if that sentence and this control ever stop
 * agreeing. This spec is the other half: it checks the sentence is true in a browser.
 *
 * HONEST LIMIT: the fixture has no recurrence_exceptions, so EXDATE has no coverage here.
 * That is covered by unit tests on the emitter instead — packages/domain/src/ics.test.ts.
 */

const titles = ['Legal Call', 'Team Standup', 'Lunch with Sarah']

/** Open Security & data and hand back the export button. */
const exportButton = async (page: import('@playwright/test').Page) => {
  await page.goto('/settings/security')
  const button = page.getByRole('button', { name: 'Export as .ics' })
  await expect(button).toBeVisible()
  return button
}

test('the control lives in Settings, under Security & data', async ({ page }) => {
  /*
   * WHERE THE PRIVACY POLICY SAYS IT IS. The copy names this location in the present tense,
   * so a move that forgets the copy is a move that makes the policy wrong again — which that
   * document has already done once, about this exact feature.
   *
   * It moved here from the Calendars card because export is data portability, and the page
   * that answers "how do I get my data out, and how do I get rid of it" is where somebody
   * looks for it. `legal.ts` moved in the same commit.
   */
  await exportButton(page)
  await expect(page.getByRole('heading', { level: 2, name: 'Your data' })).toBeVisible()
})

test('downloads a well formed calendar carrying the decrypted titles', async ({ page }) => {
  const button = await exportButton(page)

  const [download] = await Promise.all([page.waitForEvent('download'), button.click()])

  expect(download.suggestedFilename()).toMatch(/^cloakcal-\d{4}-\d{2}-\d{2}\.ics$/)

  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  const ics = Buffer.concat(chunks).toString('utf8')

  expect(ics.startsWith('BEGIN:VCALENDAR')).toBe(true)
  expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true)

  // The whole point: content the SERVER cannot read is in the file the browser produced.
  const unfolded = ics.replace(/\r\n /g, '')
  for (const title of titles) expect(unfolded).toContain(title)

  // Series stay series. Flattening a repeating event into copies would lose the wall-clock
  // guarantee the whole recurrence model exists to keep.
  expect(unfolded).toContain('RRULE:')
  expect(unfolded).toMatch(/DTSTART;TZID=/)
})

test('builds the file without sending its contents anywhere', async ({ page }) => {
  /*
   * The leak assertion, and the reason this spec exists at all. Everything else here would
   * still pass if the browser POSTed the decrypted calendar to a server on its way to disk.
   *
   * Watched at the request level rather than trusting the implementation: the fetch to
   * /api/export is expected and carries only ciphertext, so the check is that no request
   * BODY or URL anywhere carries a decrypted title.
   */
  const outgoing: string[] = []
  page.on('request', (request) => {
    outgoing.push(request.url())
    const body = request.postData()
    if (body !== null) outgoing.push(body)
  })

  const button = await exportButton(page)
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()])
  await download.createReadStream()

  const traffic = outgoing.join('\n')
  for (const title of titles) expect(traffic).not.toContain(title)
})

test('the export endpoint serves ciphertext and never a readable title', async ({ page }) => {
  // The companion to the test above, and it is what stops that one passing vacuously: the
  // server genuinely has this data, sealed, and hands it over sealed.
  await page.goto('/settings/security')
  const response = await page.request.get('/api/export')
  expect(response.ok()).toBe(true)

  const body = await response.text()
  expect(body).toContain('aes-256-gcm-v1')
  for (const title of titles) expect(body).not.toContain(title)

  // Never cached by anything in between. Sealed bytes keyed by a path with no user in it is
  // the shape of a cross-account leak even when the bytes are unreadable.
  expect(response.headers()['cache-control']).toContain('no-store')
})
