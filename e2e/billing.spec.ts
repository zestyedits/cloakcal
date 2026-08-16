import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

/**
 * The billing band on /settings/plan, in all seven of its states.
 *
 * IT REACHES THEM THROUGH `?billing=<state>`, WHICH ONLY EXISTS UNDER THE DEV FIXTURE, and
 * that is the whole reason the preview exists rather than a convenience. `CLOAKCAL_BILLING` is
 * a real environment variable and playwright.config.ts runs ONE dev server, so switching it on
 * here would switch it on for plan.spec.ts and red that file's purchase-control assertions.
 * And it would buy nothing: the demo has no account, so a genuinely flag-on fixture renders
 * the same page a flag-off one does.
 *
 * So without this file the cadence radios, the fact rows, the cancel confirmation and the
 * invoice list are measured by NOTHING — not axe in either theme, not the 44px sweep, not the
 * 390px guard. That is CLAUDE.md's "a control behind a click is a control nobody tested" one
 * level up, where the control is behind an environment and no click can reach it.
 *
 * plan.spec.ts covers the same page with billing OFF, which is production's shape. The two
 * files are the two branches, and neither is redundant.
 *
 * This file must be named in BOTH testMatch allowlists in playwright.config.ts. A spec named
 * in one is collected by half the projects and reports as full coverage;
 * apps/web/test/e2e-registration.server.test.ts fails if the two ever disagree.
 */

const STATES = [
  'none',
  'lapsed',
  'granted',
  'active',
  'cancelling',
  'past_due',
  'unreadable',
] as const

/**
 * Opens a state and returns a locator SCOPED TO THE BAND.
 *
 * Scoped, because `getByRole('button', { name })` matches the accessible name as a
 * case-insensitive SUBSTRING: page-wide, `/Switch to/` also matches the theme toggle's
 * "Switch to light mode", so four "this control must not exist here" assertions passed
 * nothing and failed for a reason that had nothing to do with billing. A negative assertion
 * has to be scoped to the thing it is denying, or it is asserting about the whole page.
 */
async function open(page: Page, state: (typeof STATES)[number]) {
  await page.goto(`/settings/plan?billing=${state}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Plan' })).toBeVisible()
  const band = page.locator(`[data-billing="${state}"]`)
  await expect(band).toBeVisible()
  return band
}

/**
 * Bounded, and never the naive `Promise.all(getAnimations().map(a => a.finished))`.
 *
 * CLAUDE.md records all three ways that one-liner hangs, and this page can hit two of them:
 * `a.finished` RESOLVES WITH THE ANIMATION OBJECT, so Playwright tries to serialise live host
 * objects back across the boundary and wedges until the test times out; and a CANCELLED
 * transition REJECTS, which a bare Promise.all turns into a failed test. Opening the cancel
 * confirmation retargets transitions mid-flight, so both are reachable here.
 *
 * The settle is still the mechanism — axe measures COMPOSITED colour and a band analysed
 * mid-rise reports every label as a contrast failure against a box that is not painted yet.
 * The 2s cap only bounds a promise that provably can fail to settle.
 */
async function settle(page: Page) {
  await page.evaluate(async () => {
    const running = document
      .getAnimations()
      .filter((a) => (a.effect?.getComputedTiming().iterations ?? 1) !== Infinity)
      .map((a) => a.finished.then(() => undefined).catch(() => undefined))
    await Promise.race([
      Promise.all(running).then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ])
  })
}

async function axeClean(page: Page) {
  await settle(page)
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])
}

test.describe('the preview itself', () => {
  test('announces that it is a demonstration, in every state', async ({ page }) => {
    for (const state of STATES) {
      await open(page, state)
      await expect(page.getByText(/Billing preview/)).toBeVisible()
    }
  })

  /**
   * A PREVIEW WHOSE BUTTONS SILENTLY DO NOTHING IS A FAKE SUCCESS, which is the exact failure
   * the disabled "Manage billing" button exists to avoid on the flag-off page. Pressing
   * through the whole cancel flow must say so and must not navigate.
   */
  test('says nothing was sent rather than quietly doing nothing', async ({ page }) => {
    await open(page, 'active')
    await page.getByRole('button', { name: 'Cancel Pro' }).click()
    await page.getByRole('group', { name: 'Confirm cancelling Pro' }).getByRole('button', {
      name: 'Cancel Pro',
    }).click()

    await expect(page.getByText('Preview only. Nothing was sent.')).toBeVisible()
    await expect(page).toHaveURL(/\/settings\/plan\?billing=active$/)
  })

  test('is unreachable without the parameter', async ({ page }) => {
    await page.goto('/settings/plan')
    await expect(page.locator('[data-billing]')).toHaveCount(0)
  })
})

/**
 * THE ROUTES THEMSELVES, WITH BILLING UNCONFIGURED — which is what every deployment and every
 * Playwright project is. These are the only tests that touch the endpoints at all, and what
 * they can prove is narrow: not that a purchase works, but that an unconfigured deployment
 * cannot be talked into one, and that nothing here answers with a REDIRECT.
 *
 * The redirect half is the one worth having. `fetch` follows a 307 while preserving the
 * method, so a route that redirects instead of answering JSON surfaces to a user as a parse
 * error rather than as "you are signed out" — and would be diagnosed as a Stripe problem.
 */
test.describe('the routes', () => {
  const PATHS = [
    '/api/billing/checkout',
    '/api/billing/portal',
    '/api/billing/subscription',
  ] as const

  for (const path of PATHS) {
    test(`${path} refuses, in JSON, without redirecting`, async ({ request }) => {
      const response = await request.post(path, {
        headers: { 'content-type': 'application/json' },
        data: { cadence: 'monthly', intent: 'cancel', flow: 'payment_method' },
        maxRedirects: 0,
      })
      // 404 because billing is off. Never 200, and never a 3xx.
      expect(response.status()).toBe(404)
      expect(response.headers()['content-type']).toContain('application/json')
      expect(await response.json()).toEqual({ error: 'billing_off' })
    })

    test(`${path} refuses a request that is not JSON`, async ({ request }) => {
      // Half the CSRF defence: a cross-site HTML form can POST with the cookie attached but
      // cannot set this header, since a form may only send form-urlencoded, multipart or
      // text/plain.
      const response = await request.post(path, {
        headers: { 'content-type': 'text/plain' },
        data: 'intent=cancel',
        maxRedirects: 0,
      })
      expect(response.status()).toBe(400)
    })
  }

  test('the webhook takes 400 on a bad signature, never a redirect and never 200', async ({
    request,
  }) => {
    const response = await request.post('/api/billing/webhook', {
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=nonsense' },
      data: { id: 'evt_1', type: 'ping' },
      maxRedirects: 0,
    })
    /*
     * 400 (bad signature) or 503 (billing unconfigured), never 404 and never a 3xx.
     *
     * 404 in particular would be the failure: Stripe counts it as permanent and disables the
     * endpoint after a few days, and a disabled endpoint is invisible from inside the app,
     * because 0024 made absence mean Free.
     */
    expect([400, 503]).toContain(response.status())
  })

  test('the webhook is reachable without a session at all', async ({ request }) => {
    // Without its PUBLIC_PATHS entry this is a 307 to /sign-in. Nothing else can see that:
    // dev and every Playwright project take middleware's dev-unlock early return.
    const response = await request.post('/api/billing/webhook', {
      headers: { 'content-type': 'application/json' },
      data: {},
      maxRedirects: 0,
    })
    expect(response.status()).not.toBe(307)
    expect(response.status()).not.toBe(302)
  })
})

test.describe('free', () => {
  test('offers a purchase, names both prices, and says where the card goes', async ({ page }) => {
    const band = await open(page, 'none')
    await expect(page.getByText('You are on Free. Everything CloakCal does today is included.')).toBeVisible()
    await expect(band.getByRole('button', { name: 'Continue to Stripe' })).toBeVisible()
    await expect(page.getByText(/Your card number never reaches CloakCal/)).toBeVisible()

    // The cadence choice IS the price cards, so both are real radios in one group.
    await expect(band.getByRole('radio')).toHaveCount(2)
    // Annual is preselected: it is the better value and the page says so three ways.
    await expect(band.getByRole('radio', { name: /Yearly/ })).toBeChecked()

    /*
     * CLICK THE CARD, not the input. The radio is a real, focusable, opacity-0 element sitting
     * under the card's own edge with `pointer-events: none`, so the LABEL is the target — which
     * is what a person actually presses and what makes the whole card a 44px-plus control.
     * `.check()` on the input fails here, correctly, and forcing it would be the test working
     * around a control the test cannot reach the way a user does.
     */
    await band.getByText('Monthly', { exact: true }).click()
    await expect(band.getByRole('radio', { name: /Monthly/ })).toBeChecked()
    await expect(band.getByRole('radio', { name: /Yearly/ })).not.toBeChecked()
  })

  test('says a lapsed account lost nothing, and lets it buy again', async ({ page }) => {
    const band = await open(page, 'lapsed')
    await expect(page.getByText(/Nothing was removed from your calendar/)).toBeVisible()
    await expect(band.getByRole('button', { name: 'Continue to Stripe' })).toBeVisible()
  })

  test('draws no management control when there is nothing to manage', async ({ page }) => {
    const band = await open(page, 'none')
    await expect(band.getByRole('button', { name: 'Cancel Pro' })).toHaveCount(0)
    await expect(band.getByRole('button', { name: /Switch to/ })).toHaveCount(0)
    await expect(band.getByRole('button', { name: 'Update payment method' })).toHaveCount(0)
  })
})

test.describe('pro', () => {
  test('states the renewal date, the amount and the card', async ({ page }) => {
    await open(page, 'active')
    await expect(page.getByText('You are on Pro. It renews on 3 March 2026.')).toBeVisible()
    await expect(page.getByText('$8 a month')).toBeVisible()
    await expect(page.getByText('Visa ending 4242')).toBeVisible()
  })

  test('offers cancel, a cadence switch and the card, and no purchase', async ({ page }) => {
    const band = await open(page, 'active')
    await expect(band.getByRole('button', { name: 'Cancel Pro' })).toBeVisible()
    await expect(band.getByRole('button', { name: 'Switch to yearly' })).toBeVisible()
    await expect(band.getByRole('button', { name: 'Update payment method' })).toBeVisible()
    await expect(band.getByRole('button', { name: 'Continue to Stripe' })).toHaveCount(0)
  })

  /**
   * The safe choice is listed FIRST so the destructive button is never where the cursor
   * already is, and the confirmation promises the calendar survives — which is the fear at
   * the moment somebody cancels a privacy product, not the loss of a feature.
   */
  test('confirms a cancellation, safe choice first, and promises the calendar survives', async ({
    page,
  }) => {
    await open(page, 'active')
    await page.getByRole('button', { name: 'Cancel Pro' }).click()

    const confirm = page.getByRole('group', { name: 'Confirm cancelling Pro' })
    await expect(confirm).toBeVisible()
    await expect(confirm.getByText(/Nothing is deleted and nothing is hidden/)).toBeVisible()
    await expect(confirm.getByText(/which you have already paid for/)).toBeVisible()

    const names = await confirm.getByRole('button').allTextContents()
    expect(names[0]).toContain('Keep Pro')

    await confirm.getByRole('button', { name: 'Keep Pro' }).click()
    await expect(confirm).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Cancel Pro' })).toBeVisible()
  })

  /**
   * A CADENCE SWITCH CHARGES A CARD IMMEDIATELY, for a prorated amount that is neither $8 nor
   * $72. The Terms promise the amount is shown before you confirm, and ADR 0009 specifies
   * preview-then-confirm — and for one commit the button posted straight through, while Cancel,
   * which moves no money today, had a two-step confirmation. This is the guard on that.
   */
  test('states what a cadence switch costs before it can be confirmed', async ({ page }) => {
    const band = await open(page, 'active')
    await band.getByRole('button', { name: 'Switch to yearly' }).click()

    const confirm = page.getByRole('group', { name: /Confirm switching to yearly/ })
    await expect(confirm).toBeVisible()
    // A real figure, not a promise of one.
    await expect(confirm.getByText(/charges you \$\d/)).toBeVisible()
    await expect(confirm.getByText(/\$72 a year/)).toBeVisible()

    // The safe choice is listed first, same rule as the cancel confirmation.
    const names = await confirm.getByRole('button').allTextContents()
    expect(names[0]).toContain('Keep monthly')

    await confirm.getByRole('button', { name: 'Keep monthly' }).click()
    await expect(confirm).toHaveCount(0)
    await expect(band.getByRole('button', { name: 'Switch to yearly' })).toBeVisible()
  })

  /**
   * TWO CONFIRMATIONS COULD RENDER AT ONCE, and neither existing test could see it because
   * each opened one panel alone. `confirmingCancel: boolean` and `proposal: {…} | null` were
   * independent state, so switch-then-cancel stacked "This charges you $64.20 today" above
   * "Cancel Pro?" with two live confirm buttons on a screen about money. One discriminated
   * union made it unrepresentable; this is what would catch it coming back.
   */
  test('never shows two confirmations at once', async ({ page }) => {
    const band = await open(page, 'active')
    await band.getByRole('button', { name: 'Switch to yearly' }).click()
    await expect(page.getByRole('group', { name: /Confirm switching/ })).toBeVisible()

    // The action row is gone while a confirmation is open, so there is nothing to press.
    await expect(band.getByRole('button', { name: 'Cancel Pro' })).toHaveCount(0)
    await expect(page.getByRole('group')).toHaveCount(1)
  })

  test('offers to keep Pro while cancelling, and withholds a second cancel', async ({ page }) => {
    const band = await open(page, 'cancelling')
    await expect(page.getByText('You are on Pro until 3 March 2026, and it will not renew.')).toBeVisible()
    await expect(band.getByRole('button', { name: 'Keep Pro' })).toBeVisible()
    // Two conflicting instructions in flight is how somebody pays for a year they were in
    // the middle of cancelling.
    await expect(band.getByRole('button', { name: 'Cancel Pro' })).toHaveCount(0)
    await expect(band.getByRole('button', { name: /Switch to/ })).toHaveCount(0)
    // The card stays reachable: one that expires inside the notice period is a real problem.
    await expect(band.getByRole('button', { name: 'Update payment method' })).toBeVisible()
  })

  test('points a failing payment at the card, and withholds the cadence switch', async ({
    page,
  }) => {
    const band = await open(page, 'past_due')
    await expect(page.getByText('Your last payment did not go through.')).toBeVisible()
    await expect(page.getByText(/Nothing is locked/)).toBeVisible()
    await expect(band.getByRole('button', { name: 'Update payment method' })).toBeVisible()
    await expect(band.getByRole('button', { name: 'Cancel Pro' })).toBeVisible()
    // A proration charged to a card Stripe already cannot take is a second failure, not a fix.
    await expect(band.getByRole('button', { name: /Switch to/ })).toHaveCount(0)
  })

  test('falls back to a card summary when the processor gave none', async ({ page }) => {
    await open(page, 'past_due')
    await expect(page.getByText('On file at Stripe')).toBeVisible()
  })

  test('lists invoices without a table', async ({ page }) => {
    await open(page, 'active')
    await expect(page.getByRole('heading', { name: 'Invoices' })).toBeVisible()
    await expect(page.getByText('3 February 2026')).toBeVisible()
    await expect(page.locator('table')).toHaveCount(0)
  })
})

/**
 * PRO WITH NO SUBSCRIPTION IS AN ACCOUNT GRANTED PRO BY HAND, and every management control
 * keys off the subscription id rather than off the plan for exactly this case. A Cancel button
 * here would post a null id and 500 on an account that never paid.
 */
test.describe('granted and unreadable', () => {
  test('gives a granted account no controls and explains why', async ({ page }) => {
    const band = await open(page, 'granted')
    await expect(page.getByText(/given Pro directly rather than through a payment/)).toBeVisible()
    for (const name of ['Cancel Pro', 'Update payment method', 'Continue to Stripe']) {
      await expect(band.getByRole('button', { name })).toHaveCount(0)
    }
    await expect(band.getByRole('button', { name: /Switch to/ })).toHaveCount(0)
    await expect(band.getByRole('radio')).toHaveCount(0)
  })

  /**
   * A degraded read means we do not know what this account is on, and `loadPlan` already
   * degraded it to Free to get here. Offering "Continue to Stripe" to somebody who may
   * already be paying, who presses it, produces a second subscription and two charges a
   * month. Generosity is right for a badge and wrong for a button.
   */
  test('offers nothing at all when the read failed, and says nothing was charged', async ({
    page,
  }) => {
    const band = await open(page, 'unreadable')
    await expect(page.getByText('We could not read your billing details just now.')).toBeVisible()
    await expect(page.getByText(/nothing has been charged/)).toBeVisible()
    for (const name of ['Continue to Stripe', 'Cancel Pro', 'Update payment method']) {
      await expect(band.getByRole('button', { name })).toHaveCount(0)
    }
    // Not even a price card, because each one is a radio that decides an amount.
    await expect(band.getByRole('radio')).toHaveCount(0)
  })
})

test.describe('test mode', () => {
  test('says so wherever a control could move money, and nowhere else', async ({ page }) => {
    for (const state of ['none', 'lapsed', 'active', 'cancelling', 'past_due'] as const) {
      await open(page, state)
      await expect(
        page.getByText(/Billing is in test mode/),
        `${state} can act, so it must warn`,
      ).toBeVisible()
    }

    // Nothing here can move money, so a warning about money would be noise.
    for (const state of ['granted', 'unreadable'] as const) {
      await open(page, state)
      await expect(
        page.getByText(/Billing is in test mode/),
        `${state} has no controls, so it must not warn`,
      ).toHaveCount(0)
    }
  })
})

test.describe('accessibility', () => {
  /*
   * BOTH THEMES. Every axe run in this repo scanned dark until /settings/plan, and light is
   * where --text-tertiary measures about 3.3:1 and where this repo has now shipped four
   * separate AA failures. The two states below carry every new control between them.
   */
  for (const state of ['none', 'active'] as const) {
    test(`${state} scans clean in the dark theme`, async ({ page }) => {
      await open(page, state)
      await axeClean(page)
    })

    test(`${state} scans clean in the light theme`, async ({ page }) => {
      await open(page, state)
      await page.getByRole('button', { name: 'Switch to light mode' }).click()
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
      await axeClean(page)
    })
  }

  /**
   * CONTROLS BEHIND A CLICK GET THEIR OWN SCAN. The danger-button contrast failure this repo
   * shipped was found exactly this way and no other way: axe only sees what is on screen, and
   * the confirm button does not exist until somebody asks for it.
   */
  test('the cancel confirmation scans clean, open, in the light theme', async ({ page }) => {
    await open(page, 'active')
    await page.getByRole('button', { name: 'Switch to light mode' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.getByRole('button', { name: 'Cancel Pro' }).click()
    await expect(page.getByRole('group', { name: 'Confirm cancelling Pro' })).toBeVisible()
    await axeClean(page)
  })

  test('the switch confirmation scans clean, open, in the light theme', async ({ page }) => {
    const band = await open(page, 'active')
    await page.getByRole('button', { name: 'Switch to light mode' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await band.getByRole('button', { name: 'Switch to yearly' }).click()
    await expect(page.getByRole('group', { name: /Confirm switching/ })).toBeVisible()
    await axeClean(page)
  })

  test('gives every control a 44px touch target, in every state', async ({ page }) => {
    for (const state of STATES) {
      await open(page, state)
      const measured = await page.evaluate(() =>
        Array.from(document.querySelectorAll('button, a[href], input, label')).map((el) => {
          const style = getComputedStyle(el)
          return {
            label: (el.textContent ?? '').trim().slice(0, 30) || el.tagName,
            height: Math.round(el.getBoundingClientRect().height),
            /*
             * WHAT CAN ACTUALLY BE POINTED AT, which is not the same as what is in the DOM.
             *
             * The cadence radios are real, focusable, keyboard-operable inputs deliberately
             * rendered at opacity 0 with `pointer-events: none`, sitting under their own
             * card's edge. The TARGET is the <label> wrapping the whole card, which this
             * sweep measures instead and which is far over 44px. Excluding them is not a
             * carve-out for a failing control: an element that cannot receive a pointer event
             * has no pointer target for WCAG 2.5.8 to size, and the label it belongs to does.
             *
             * Measured from the computed style rather than assumed from the selector, so a
             * future control that quietly acquires `pointer-events: none` while still being
             * clickable cannot slip past by looking like this one.
             */
            pointable: style.pointerEvents !== 'none',
          }
        }),
      )
      expect(measured.length).toBeGreaterThan(0)
      const tooSmall = measured
        .filter((m) => m.pointable && m.height > 0 && m.height < 44)
        .map((m) => `${state} ${m.label}: ${m.height}px`)
      expect(tooSmall).toEqual([])
    }
  })

  /**
   * The fact rows are the risk this cannot be inherited from plan.spec.ts: "Visa ending 4242"
   * and a spelled-out date sit in a grid, and a grid item's default min-width is its CONTENT.
   * Nothing else in this suite measures it.
   */
  test('never scrolls sideways at 390px, in any state', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    for (const state of STATES) {
      await open(page, state)
      const { client, scroll } = await page.evaluate(() => ({
        client: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
      }))
      expect(scroll, `${state} overflows at 390px`).toBeLessThanOrEqual(client + 1)
    }
  })

  test('keeps every heading in a sensible order', async ({ page }) => {
    await open(page, 'active')
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

  test('carries no em dash, in any state', async ({ page }) => {
    for (const state of STATES) {
      await open(page, state)
      expect(await page.content(), `${state} carries an em dash`).not.toContain('—')
    }
  })
})
