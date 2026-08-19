import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

/**
 * Settings under the dev fixture: no workspace and no session, so everything needing a row to
 * write to renders disabled with honest copy. That split is deliberate and mirrors the CRUD
 * suite — e2e owns structure, headings, targets and honesty; the db tests own what the RPCs
 * actually do. A fixture that could mutate real data would prove less, not more.
 *
 * The four DISPLAY preferences are the exception, and it is not a weakening. They write to a
 * cookie (lib/demo-prefs.ts), so the demo shows them working without touching an account.
 *
 * ONE FILE FOR ALL FIVE SETTINGS ROUTES, on purpose. playwright.config's device projects use
 * an explicit testMatch allowlist, so a new spec file that nobody remembers to name there is
 * collected by no project and silently never runs — the same orphan problem the visual
 * baselines had. /settings/security was written in here for that reason; the hub's two new
 * children join it rather than starting two more files nobody has registered.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/settings')
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
})

/* ── The hub ─────────────────────────────────────────────────────────────────────────── */

test('is four doors and nothing else, in the stated order', async ({ page }) => {
  /*
   * THREE doors here, not four: Billing renders only when `billingEnabled()` is true, and it
   * is false in every environment this suite runs in. That is the point of the gate — a tier
   * row in front of somebody with nothing to decide is furniture, and a price for something
   * unbuyable is worse than furniture.
   *
   * THE ORDER, read off the DOM. Privacy is first because it is the product; the page this
   * replaced opened with Appearance, so the first thing a new account saw in Settings was a
   * theme picker. `toHaveText` on a multi-element locator is an exact, ordered, full-list
   * equality, so this also fails if any other h2 appears anywhere on the page — which is the
   * assertion that keeps the hub a hub.
   */
  await expect(page.getByRole('heading', { level: 2 })).toHaveText([
    'Privacy',
    'Calendar',
    'Security & data',
  ])
})

test('does not offer Billing while nothing can be bought or managed', async ({ page }) => {
  await expect(page.getByRole('heading', { level: 2, name: 'Billing' })).toHaveCount(0)
  // `exact`, because `getByRole('link', { name })` matches a case-insensitive SUBSTRING and a
  // loose negative assertion is one that quietly asks about the whole page.
  await expect(page.getByRole('link', { name: 'Billing', exact: true })).toHaveCount(0)
})

test('each door states what is true right now, and opens its page', async ({ page }) => {
  const doors = [
    { name: 'Privacy', href: '/settings/privacy', h1: 'Privacy' },
    { name: 'Calendar', href: '/settings/calendar', h1: 'Calendar' },
    { name: 'Security & data', href: '/settings/security', h1: 'Security & data' },
  ]

  for (const door of doors) {
    // `exact` because the accessible name is the LABEL ALONE (aria-labelledby), and because
    // "Privacy" is also a substring of the footer's "Privacy policy".
    const link = page.getByRole('link', { name: door.name, exact: true })
    await expect(link).toHaveAttribute('href', door.href)
    /*
     * "Demo" on every line, and that is a rule rather than a shortcut. A plan, a contact
     * count, a calendar count and a passkey count are all ACCOUNT facts, and the fixture has
     * no account — the readout band this replaced answered four of those questions at display
     * size about an account that does not exist.
     */
    await expect(link).toContainText('Demo')
  }

  for (const door of doors) {
    await page.goto('/settings')
    await page.getByRole('link', { name: door.name, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`${door.href}$`))
    await expect(page.getByRole('heading', { level: 1, name: door.h1 })).toBeVisible()
    await expect(page.locator('h1')).toHaveCount(1)
  }
})

test('carries no telemetry band and no roadmap', async ({ page }) => {
  /*
   * The two things the hub deliberately dropped, pinned so they cannot drift back.
   *
   * The readout was "02 calendars / 01 people / 01 rules" at display size — dashboard
   * telemetry rather than a decision anybody was about to make, and every figure in it is now
   * a phrase on the door you would press to change it. The roadmap put three unbuilt features
   * inside the settings home, at the exact moment a reader is deciding whether the product can
   * be trusted with their calendar. Both facts survive: the counts as summary lines, the gaps
   * stated beside the thing each one is missing from.
   */
  await expect(page.getByLabel('At a glance')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: "What's next" })).toHaveCount(0)
  await expect(page.getByText('Coming soon')).toHaveCount(0)
})

test('names the legal links so neither collides with a door', async ({ page }) => {
  /*
   * "Privacy policy", not "Privacy". There is a door called Privacy on this page and
   * `getByRole('link', { name })` matches case-insensitive SUBSTRINGS, so two links whose
   * names differ only by a word nobody says out loud is an ambiguity in the suite and a real
   * one for anybody navigating by link list. CLAUDE.md records the same trap costing four
   * negative assertions their meaning.
   */
  await expect(page.getByRole('link', { name: 'Privacy policy' })).toHaveAttribute(
    'href',
    '/privacy',
  )
  await expect(page.getByRole('link', { name: 'Terms of service' })).toHaveAttribute(
    'href',
    '/terms',
  )
})

test('forwards the anchors the accordion used to answer', async ({ page }) => {
  /*
   * A HASH NEVER REACHES THE SERVER, so this cannot be middleware or a `redirects()` entry
   * however much it looks like one. `/account` has redirected to `/settings#security` since
   * M1 and the address may be bookmarked; seven anchors dying quietly would turn an old link
   * into a page that scrolls to nothing.
   *
   * The hub renders and then forwards. That flash is the price, and it is unavoidable.
   */
  for (const [hash, destination] of [
    ['security', '/settings/security'],
    ['sharing', '/settings/privacy'],
    ['time-region', '/settings/calendar'],
    ['appearance', '/settings/calendar'],
  ] as const) {
    await page.goto(`/settings#${hash}`)
    await expect(page).toHaveURL(new RegExp(`${destination}$`))
  }

  // An unrecognised fragment leaves the reader where they are. Guessing a destination for an
  // arbitrary hash is how an open redirect gets written, and a hub is a fine place to land.
  await page.goto('/settings#nonsense')
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
  await expect(page).toHaveURL(/\/settings#nonsense$/)
})

/* ── /settings/calendar ──────────────────────────────────────────────────────────────── */

test('the calendar page holds the display preferences, all at once', async ({ page }) => {
  /*
   * NO ACCORDION, and that retires a CI-only failure rather than working around it.
   *
   * These four controls used to live in two `<details>` cards that opened one at a time, so a
   * test touching all four had to open each before asserting on it — and the version that did
   * not passed anyway, because `toBeEnabled()` does not imply visible. It then waited 30s for
   * a `selectOption` inside a collapsed card. It failed only on CI, so a broken test read as a
   * flaky pipeline for five commits. There is nothing left to collapse.
   */
  await page.goto('/settings/calendar')
  await expect(page.getByRole('heading', { level: 2 })).toHaveText([
    'Calendars',
    'Time & region',
    'Appearance',
    'Availability',
  ])

  await expect(page.getByText(/kept in this browser only/).first()).toBeVisible()

  for (const label of ['Timezone', 'Week starts on', 'Default view', 'Keyboard shortcuts']) {
    await expect(page.getByLabel(label)).toBeVisible()
    await expect(page.getByLabel(label)).toBeEnabled()
  }

  // The demo models a user who OPTED IN to single-key shortcuts, which is why the hotkey suite
  // has a live keyboard to test. It is not the product default: WCAG 2.1.4 wants those off
  // until asked for, and that default is pinned on the 0022 column and its db test.
  await expect(page.getByLabel('Keyboard shortcuts')).toHaveValue('on')

  // The one that matters most, end to end: choose it, reload, it is still chosen. A preference
  // that forgets on refresh is worse than one that is disabled, because it looks like it
  // worked.
  await page.getByLabel('Default view').selectOption('month')
  await page.reload()
  await expect(page.getByLabel('Default view')).toHaveValue('month')
})

test('the calendar page stays honest about what the demo cannot do', async ({ page }) => {
  await page.goto('/settings/calendar')
  await expect(page.getByText(/Demo data\. Sign in/).first()).toBeVisible()
  // The gap, stated beside the thing it is missing from rather than in a roadmap footer two
  // screens away. This is what replaced the "Deleting calendars" row.
  await expect(page.getByText(/Calendars cannot be deleted yet/)).toBeVisible()
  // Availability is a signpost here, not a section: seven days of multi-window rows is a page.
  await expect(page.getByRole('link', { name: 'Open Availability' })).toHaveAttribute(
    'href',
    '/settings/availability',
  )
  await expect(page.getByText(/Nothing books itself yet/).first()).toBeVisible()
})

test('the theme radios switch the page and persist across reload', async ({ page }) => {
  await page.goto('/settings/calendar')
  await page.getByRole('radio', { name: 'Light' }).check()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  // Back to the default so later tests and screenshots see dark.
  await page.getByRole('radio', { name: /Dark/ }).check()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})

/* ── /settings/privacy ───────────────────────────────────────────────────────────────── */

test('privacy is the first door and owns the visibility defaults', async ({ page }) => {
  await page.goto('/settings/privacy')
  await expect(page.getByRole('heading', { level: 2 })).toHaveText([
    'Who sees what by default',
    'People',
    'See what they see',
  ])

  // The lede still tells the truth about the split: link and groups here, people in files.
  await expect(page.getByText(/Rules for a person live in their file/)).toBeVisible()
  await expect(page.getByText('Demo data. Sign in to set visibility.')).toBeVisible()
})

test('the privacy page is a signpost into the book, not a second manager', async ({ page }) => {
  // The contact manager lives at /people; a copy left behind would drift.
  await page.goto('/settings/privacy')
  await expect(page.getByRole('link', { name: 'Open People' })).toHaveAttribute('href', '/people')
  await expect(page.getByRole('button', { name: 'Add contact' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Add group' })).toHaveCount(0)
})

test('the privacy page does not grow a third audience picker', async ({ page }) => {
  /*
   * The sidebar's View As bar and the Cloak sheet already both draw the audience map, and the
   * last time two surfaces did that on one screen there were two live "Viewing as" selects
   * bound to the same state. This page says where the preview lives and gets out of the way.
   */
  await page.goto('/settings/privacy')
  await expect(page.getByLabel(/Viewing as/)).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Open the calendar' })).toHaveAttribute('href', '/')
})

/* ── /settings/security ──────────────────────────────────────────────────────────────── */

test('security is a page of its own, reachable from the hub', async ({ page }) => {
  await page.goto('/settings/security')
  await expect(page.getByRole('heading', { level: 1, name: 'Security & data' })).toBeVisible()

  // The regression this route exists to fix: ChangePassword used to bring its own lockup and
  // its own h1 into whatever rendered it, so /settings had TWO h1s and a stray brand mark
  // mid-scroll. Exactly one h1, wherever these flows are rendered.
  await expect(page.locator('h1')).toHaveCount(1)

  // The demo state is signalled by an explicit flag, not by an empty email string. That
  // sentinel had quietly become load-bearing for this whole route: a signed-in user whose
  // Supabase email is null — phone auth, or an OAuth identity that returns none — would have
  // been told "Demo. Sign in to manage your password" while signed in. The fixture cannot
  // reach that branch, so this asserts the demo half and demo-sentinel.server.test.ts covers
  // the mechanism.
  await expect(page.getByText(/Demo\. Sign in to manage your password/)).toBeVisible()

  await page.getByRole('link', { name: '‹ Settings' }).click()
  await expect(page).toHaveURL(/\/settings$/)
})

test('export lives with the rest of your data, and works in the demo', async ({ page }) => {
  /*
   * MOVED HERE FROM THE CALENDARS CARD, and the privacy policy moved with it in the same
   * commit — `legal.ts` names the location in the present tense, and a control that moves
   * without its copy is how that document came to claim a feature that did not exist.
   *
   * It renders in the demo because export needs no account: hiding it from the fixture would
   * hide the only control on this page a stranger can actually press, and axe only sees what
   * is on screen.
   */
  await page.goto('/settings/security')
  await expect(page.getByRole('heading', { level: 2, name: 'Your data' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 3, name: 'Export' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Export as .ics' })).toBeVisible()
})

test('deletion is offered as an address, never as a button', async ({ page }) => {
  /*
   * Nothing in this app can reach `auth.users` — rule 4 bans the service-role key,
   * security-posture bans SECURITY DEFINER, and `auth.users` has no RLS to scope a narrow role
   * against. So a "Delete account" control would clear a calendar and leave an email address
   * and a user id on file, which is a worse answer than the paragraph that is there.
   *
   * The positive half matters as much as the negative one: before this page there was no
   * mailto anywhere in the product, and the privacy policy said "by emailing us" without ever
   * giving an address. The promise was honest and unusable.
   */
  await page.goto('/settings/security')
  await expect(page.getByRole('heading', { level: 3, name: 'Deleting your account' })).toBeVisible()
  await expect(page.getByRole('link', { name: /hello@cloakcal\.com/ })).toHaveAttribute(
    'href',
    /^mailto:hello@cloakcal\.com/,
  )
  for (const name of ['Delete account', 'Delete my account', 'Close account']) {
    await expect(page.getByRole('button', { name })).toHaveCount(0)
  }
})

test('the passkeys card is offered, and says why it cannot act in the demo', async ({ page }) => {
  await page.goto('/settings/security')

  // Rendered in the DEMO branch deliberately. Playwright has no session, so a control that
  // appears only when signed in is measured by neither the axe scan nor the 44px sweep below
  // — the two assertions on this page that exist to catch exactly this class of problem would
  // go on passing while checking nothing.
  await expect(page.getByRole('heading', { level: 2, name: 'Passkeys' })).toBeVisible()

  // Never a control that silently does nothing: it is disabled AND the page says why.
  await expect(page.getByRole('button', { name: 'Add a passkey' })).toBeDisabled()
  await expect(page.getByText('Demo. Sign in to add a passkey.')).toBeVisible()
})

test('the roadmap no longer claims the phrase is the only way back', async ({ page }) => {
  await page.goto('/settings/security')
  // The empty devices state used to read "until then your recovery phrase is the single way
  // back in", which passkeys made false. Copy that outlives the code it describes is how a
  // product starts lying to its users in small ways.
  await expect(page.getByText(/single way back in/)).toHaveCount(0)
})

/* ── Sweeps, on every settings route ─────────────────────────────────────────────────── */

const ROUTES = ['/settings', '/settings/privacy', '/settings/calendar', '/settings/security']

for (const route of ROUTES) {
  test(`${route} never scrolls sideways`, async ({ page }) => {
    /*
     * A page wider than its viewport, pinned. The accordion shipped this the moment its
     * summary titles were told not to wrap: a `<details>` is a GRID ITEM, grid items default
     * to content-based `min-width`, and the nowrap title plus its state string sized the card
     * to 469px inside a 390px phone even though the state carried `text-overflow: ellipsis`.
     *
     * The hub can reproduce it a different way — its doors are grid items too, which is why
     * `.doors` uses `minmax(0, 1fr)` rather than a bare `1fr` — so this runs on every settings
     * route now rather than on the one that happened to fail first. Nothing else here measures
     * it: axe does not, the 44px sweep does not, and the screenshots are per-project so none
     * of them compares a page against its own viewport.
     */
    await page.goto(route)
    const { client, scroll } = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }))
    expect(scroll).toBeLessThanOrEqual(client + 1)
  })

  test(`${route} has no detectable WCAG A or AA violations`, async ({ page }) => {
    await page.goto(route)
    await settle(page)
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])
  })

  test(`${route} gives every interactive control a 44px touch target`, async ({ page }) => {
    await page.goto(route)
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

  test(`${route} keeps every heading in a sensible order`, async ({ page }) => {
    await page.goto(route)
    const levels = await page.evaluate(() =>
      Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) =>
        Number(h.tagName.slice(1)),
      ),
    )
    expect(levels.length).toBeGreaterThan(0)
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(1)
    }
  })
}

/**
 * Wait for animations, BOUNDED.
 *
 * `Promise.all(getAnimations().map((a) => a.finished))` hangs three ways and the repo's old
 * one-liner hit all three: `finished` resolves with the animation OBJECT, so Playwright tries
 * to serialise live host objects back across the boundary; an infinite animation never settles
 * at all; and a cancelled transition rejects, failing the whole `Promise.all`. The settle is
 * still the mechanism — axe measures COMPOSITED colour, and analysing mid-transition reports
 * every label as a contrast failure against a box that is not painted yet — the cap only bounds
 * a promise that provably can fail to settle.
 */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const running = document
      .getAnimations()
      .filter((a) => {
        const timing = a.effect?.getComputedTiming()
        return timing !== undefined && Number.isFinite(timing.activeDuration)
      })
      .map((a) => a.finished.catch(() => undefined))
    await Promise.race([
      Promise.all(running).then(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ])
  })
}



