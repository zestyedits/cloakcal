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
  // SIX cards, not seven and no longer five. Two of the original seven held no settings at
  // all — People was a lede and a link, "Coming soon" was four rows of things that do not
  // exist — and both wore the same card and chevron as the cards that work. Plan joined
  // last, as a signpost.
  const sections = [
    'Appearance',
    'Time & region',
    'Calendars',
    'People & sharing',
    'Security',
    'Plan',
  ]

  // THE ORDER, read off the DOM — which this test has always claimed in its name and never
  // actually checked. The body used to loop the list asserting each heading was VISIBLE, so
  // a section could be inserted anywhere, or two could swap, and the suite stayed green.
  // Found while adding the sixth card. "What's next" is the footer's h2 and is asserted
  // here rather than filtered out, so the footer cannot silently vanish either.
  await expect(page.getByRole('heading', { level: 2 })).toHaveText([...sections, "What's next"])

  for (const name of sections) {
    // The h2 lives in the summary row, so it stays visible while the card is closed.
    await expect(page.getByRole('heading', { level: 2, name })).toBeVisible()
  }
  // The nav chip navigates to its anchor, opens the card it points at, and MARKS itself —
  // a deep link that lands on a closed row would appear to do nothing, and a rail with no
  // active state cannot say where it just sent you.
  await page.getByRole('link', { name: 'Security' }).click()
  await expect(page).toHaveURL(/#security$/)
  await expect(page.locator('#security')).toHaveAttribute('open', '')
  await expect(page.getByRole('link', { name: 'Security' })).toHaveAttribute('aria-current', 'true')
})

test('sections are closed by default with their state on the row', async ({ page }) => {
  // The page reads as a table of contents: only Appearance opens by default, and every
  // closed row still says what its current value is.
  await expect(page.locator('#appearance')).toHaveAttribute('open', '')
  for (const id of ['time-region', 'calendars', 'sharing', 'security', 'plan']) {
    await expect(page.locator(`#${id}`)).not.toHaveAttribute('open', '')
  }
  await expect(page.getByText('Password & recovery phrase')).toBeVisible()
  // "Demo", not "Free". A plan is an account fact and the fixture has no account, so the
  // closed row must not answer a question nobody can ask here.
  await expect(page.locator('#plan').getByText('Demo', { exact: true })).toBeVisible()

  // Clicking a summary opens the card.
  await page.getByRole('heading', { level: 2, name: 'Calendars' }).click()
  await expect(page.locator('#calendars')).toHaveAttribute('open', '')
})

test('demo display preferences work, and say where they are kept', async ({ page }) => {
  // Appearance is open by default and holds the view and keyboard preferences; time and
  // region holds the two that are actually about time and region.
  await page.getByRole('heading', { level: 2, name: 'Time & region' }).click()
  await expect(page.getByText(/kept in this browser only/).first()).toBeVisible()

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
  await page.getByRole('heading', { level: 2, name: 'People & sharing' }).click()
  await expect(page.getByRole('link', { name: 'Open People' })).toHaveAttribute(
    'href',
    '/people',
  )
  await expect(page.getByRole('button', { name: 'Add contact' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Add group' })).toHaveCount(0)
})

test('the sharing card names where per-person rules went', async ({ page }) => {
  // Fixture settings has no workspace, so the card shows the honest demo sentence; the
  // lede still tells the truth about the split (link and groups here, people in files).
  await page.getByRole('heading', { level: 2, name: 'People & sharing' }).click()
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

test('the deferred rows are named, quiet, and not dressed as settings', async ({ page }) => {
  // No longer a card behind a chevron: four things that do not exist wore the same box
  // and weight as four that do. Named, because an honest roadmap is worth something, and
  // in a footer, because none of them work.
  for (const name of ['Device pairing', 'Booking', 'Export']) {
    await expect(page.getByText(name, { exact: true })).toBeVisible()
  }
  await expect(page.getByRole('heading', { level: 2, name: "What's next" })).toBeVisible()
  await expect(page.locator('#more')).toHaveCount(0)
})

test('never scrolls sideways', async ({ page }) => {
  /*
   * A page wider than its viewport, pinned. This shipped the moment the summary titles
   * were told not to wrap: a <details> is a GRID ITEM, grid items default to
   * `min-width: auto` (content-based), and so the nowrap title plus the state string
   * beside it sized the card to their sum — 469px inside a 390px phone — even though the
   * state carried `text-overflow: ellipsis`. `min-width: 0` on the CONTAINER does nothing
   * for this; it has to be on the item.
   *
   * The failure is invisible to everything else here. Axe does not measure it, the 44px
   * sweep does not measure it, and the screenshots are per-project so nothing compares a
   * page against its own viewport. It is the same family as the max-width feedback loop
   * recorded in CLAUDE.md, and it took a measurement to see either one.
   */
  const { client, scroll } = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }))
  expect(scroll).toBeLessThanOrEqual(client + 1)
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

/**
 * /settings/security — the page the password and recovery-phrase flows moved onto.
 *
 * Written into THIS file rather than a new spec on purpose: playwright.config's device
 * projects use an explicit testMatch allowlist, so a new spec file that nobody remembers
 * to name there is collected by no project and silently never runs. Same orphan problem
 * the visual baselines had.
 */

test('security is a page of its own, reachable from the settings card', async ({ page }) => {
  await page.getByRole('heading', { level: 2, name: 'Security' }).click()
  // The demo has no session, so the card says so rather than linking to a page that would
  // bounce. The link itself is covered by the direct visit below.
  await expect(page.getByText(/Sign in to manage your password/)).toBeVisible()

  await page.goto('/settings/security')
  await expect(page.getByRole('heading', { level: 1, name: 'Security' })).toBeVisible()

  // The regression this route exists to fix: ChangePassword used to bring its own lockup
  // and its own h1 into whatever rendered it, so /settings had TWO h1s and a stray brand
  // mark mid-scroll. Exactly one h1, wherever these flows are rendered.
  await expect(page.locator('h1')).toHaveCount(1)

  // The demo state is signalled by an explicit flag, not by an empty email string. That
  // sentinel had quietly become load-bearing for this whole route: a signed-in user whose
  // Supabase email is null — phone auth, or an OAuth identity that returns none — would
  // have been told "Demo. Sign in to manage your password" while signed in. The fixture
  // cannot reach that branch, so this asserts the demo half and the source-level test
  // below covers the mechanism.
  await expect(page.getByText(/Demo\. Sign in to manage your password/)).toBeVisible()

  await page.getByRole('link', { name: '‹ Settings' }).click()
  await expect(page).toHaveURL(/\/settings$/)
})

test('the security page scans clean and keeps its targets', async ({ page }) => {
  await page.goto('/settings/security')
  await expect(page.getByRole('heading', { level: 1, name: 'Security' })).toBeVisible()
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])

  const tooSmall = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button, a[href]'))
      .filter((el) => el.getBoundingClientRect().height > 0)
      .filter((el) => el.getBoundingClientRect().height < 44)
      .map((el) => `${(el.textContent ?? '').trim().slice(0, 30)}: ${Math.round(el.getBoundingClientRect().height)}px`),
  )
  expect(tooSmall).toEqual([])

  // This page had the h1-count assertion but never a level-skip sweep, which stopped
  // mattering the moment it grew an h2. Both belong here: one h1 is about duplication,
  // this is about the outline being navigable.
  const levels = await page.evaluate(() =>
    Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((el) =>
      Number(el.tagName.slice(1)),
    ),
  )
  for (let i = 1; i < levels.length; i += 1) {
    expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(1)
  }
})

test('the passkeys card is offered, and says why it cannot act in the demo', async ({ page }) => {
  await page.goto('/settings/security')

  // Rendered in the DEMO branch deliberately. Playwright has no session, so a control that
  // appears only when signed in is measured by neither the axe scan nor the 44px sweep
  // above — the two assertions on this page that exist to catch exactly this class of
  // problem would go on passing while checking nothing.
  await expect(page.getByRole('heading', { level: 2, name: 'Passkeys' })).toBeVisible()

  // Never a control that silently does nothing: it is disabled AND the page says why.
  await expect(page.getByRole('button', { name: 'Add a passkey' })).toBeDisabled()
  await expect(page.getByText('Demo. Sign in to add a passkey.')).toBeVisible()
})

test('the security page never scrolls sideways', async ({ page }) => {
  await page.goto('/settings/security')
  // The guard that belongs on any page growing a nowrap or fixed-width element. The passkey
  // list is exactly that shape — a date, a monospace id and a 44px button on one line — and
  // nothing else here measures it: axe does not, the target sweep does not, and the existing
  // sideways assertion runs against /settings rather than this route.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
})

test('the roadmap no longer claims the phrase is the only way back', async ({ page }) => {
  await page.goto('/settings/security')
  // The empty devices state used to read "until then your recovery phrase is the single
  // way back in", which passkeys made false. Copy that outlives the code it describes is
  // how a product starts lying to its users in small ways.
  await expect(page.getByText(/single way back in/)).toHaveCount(0)
})
