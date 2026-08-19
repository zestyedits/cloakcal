import { expect, test, type Page } from '@playwright/test'

/**
 * The Content-Security-Policy, in a real browser.
 *
 * WHAT THIS CAN AND CANNOT PROVE, stated first because it bounds every test below.
 *
 * Playwright runs `next dev`, so the policy exercised here is the DEVELOPMENT one — looser by
 * two named directives (`'unsafe-eval'` for React Refresh, `ws:` for HMR). The production
 * string is asserted in `apps/web/test/security-headers.server.test.ts`, which reads it out
 * of `buildCsp` directly. Neither file is sufficient alone: this one proves the policy does
 * not break the app, that one proves the policy that ships is strict.
 *
 * Neither can prove `connect-src` is right, and that is the gap worth naming. The fixture
 * never calls Supabase, so a missing or wrong origin there passes every test in this repo and
 * breaks every real account on the first query. Only a live-account pass sees it.
 *
 * The reason for the violation listeners rather than screenshot assertions: a CSP failure is
 * SILENT in the UI. A blocked script does not render an error, it renders a page missing a
 * feature — which looks like a bug in the feature.
 */

const CSP = 'content-security-policy'

/** Every CSP violation the page reports, plus the console errors that accompany them. */
function watchViolations(page: Page): string[] {
  const violations: string[] = []
  page.on('console', (message) => {
    const text = message.text()
    if (/content security policy|refused to (execute|load|apply|connect)/i.test(text)) {
      violations.push(text)
    }
  })
  page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      // eslint-disable-next-line no-console
      console.error(
        `CSP violation: ${event.violatedDirective} blocked ${event.blockedURI || 'inline'}`,
      )
    })
  })
  return violations
}

test('every document response carries the policy', async ({ page }) => {
  // Six cold route compiles do not fit in one 30s budget on a dev server eight workers
  // share. Same call the sub-page walk below already made.
  test.slow()
  // Including the auth pages, which stopped being prerendered for exactly this reason: a
  // per-request nonce cannot exist in a page built once. If any of these lost the header it
  // would be the pages handling passwords that lost it.
  //
  // And /contact, which is PUBLIC and reachable signed out. A route a stranger can load is
  // the last one that should be trusted to have kept its header by accident.
  for (const path of ['/', '/sign-in', '/sign-up', '/recover', '/settings', '/contact']) {
    const response = await page.goto(path)
    const header = response?.headers()[CSP]
    expect(header, `no CSP on ${path}`).toBeTruthy()
    expect(header).toContain("object-src 'none'")
    expect(header).toContain("frame-ancestors 'none'")
  }
})

test('the policy is present in fixture mode, which is where every other test runs', async ({
  page,
}) => {
  // THE structural test. Middleware returns early when NEXT_PUBLIC_CLOAKCAL_DEV_UNLOCK=1, and
  // every Playwright project sets it — so a policy applied after that branch would be absent
  // here, absent in dev, and present only in production where nothing runs. That is the
  // /opengraph-image bug's exact shape. This test is what makes the ordering observable.
  const response = await page.goto('/')
  expect(response?.headers()[CSP]).toBeTruthy()
  expect(response?.headers()['x-content-type-options']).toBe('nosniff')
  expect(response?.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin')
})

test('the theme script carries a nonce the header names, and it changes per response', async ({
  page,
}) => {
  const first = await page.goto('/')
  const firstCsp = first?.headers()[CSP] ?? ''
  const firstHtml = await first?.text() ?? ''

  const nonceInHeader = /'nonce-([^']+)'/.exec(firstCsp)?.[1]
  const nonceOnScript = /<script nonce="([^"]+)"/.exec(firstHtml)?.[1]

  expect(nonceInHeader, 'no nonce in the policy').toBeTruthy()
  expect(nonceOnScript, 'the theme bootstrap has no nonce').toBeTruthy()
  // They must MATCH. A mismatch blocks the script that applies the stored theme, and the
  // symptom is a full-screen flash on navigation rather than an error.
  expect(nonceOnScript).toBe(nonceInHeader)

  const second = await page.goto('/')
  const secondNonce = /'nonce-([^']+)'/.exec(second?.headers()[CSP] ?? '')?.[1]
  // A nonce reused across responses is not a nonce — it is a static allowlist entry an
  // attacker can read out of any cached page.
  expect(secondNonce).not.toBe(nonceInHeader)
})

test('the calendar loads, decrypts and opens a sheet with no violation', async ({ page }) => {
  // The real test. Everything above proves the header exists and is well formed; this proves
  // it does not break the product. Decryption is the part that matters — if the CSP blocked
  // the bundle that runs the CloakStore, the page would render placeholders forever and look
  // like a decryption bug.
  const violations = watchViolations(page)

  await page.goto('/')
  await expect(page.getByText('Legal Call')).toBeVisible({ timeout: 15_000 })

  // A sheet, because it mounts a dialog and runs the motion system — both places inline
  // style and dynamic script would show up if either were blocked.
  await page.getByText('Legal Call').first().click()
  await page.waitForTimeout(300)

  expect(violations, violations.join('\n')).toEqual([])
})

test('settings and its sub-pages raise no violation', async ({ page }) => {
  /*
   * SLOW, because this walks seven routes and the test server is `next dev`, which compiles
   * each one on first request. The list grew from four when the settings accordion became a
   * hub with children, and the seventh cold compile is what pushed it past the default 30s —
   * a timeout that says nothing about CSP. Trebling the budget keeps the coverage; trimming
   * the list to fit would drop exactly the new routes this test exists to cover.
   */
  test.slow()
  const violations = watchViolations(page)

  for (const path of [
    '/settings',
    '/settings/privacy',
    '/settings/calendar',
    '/settings/security',
    '/settings/plan',
    '/settings/availability',
    '/sign-in',
  ]) {
    await page.goto(path)
    await page.waitForLoadState('domcontentloaded')
  }

  expect(violations, violations.join('\n')).toEqual([])
})

test('the theme still applies before paint, which is what the nonce could break', async ({
  page,
}) => {
  // The theme bootstrap is the only inline script in the app. If the nonce were wrong it
  // would be blocked, and the page would paint dark then snap to the stored theme — a
  // full-screen flash that no assertion above would notice.
  await page.goto('/')
  await page.evaluate(() => localStorage.setItem('cloakcal-theme', 'light'))
  await page.goto('/')

  // Set by the bootstrap script before first paint. If it is still the server default, the
  // script did not run.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
})
