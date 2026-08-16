import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

/**
 * The privacy policy and the terms.
 *
 * THE FIRST TEST IS THE ONE THAT MATTERS. These pages exist for people who do not have an
 * account: someone deciding whether to sign up, an app store reviewer, a payment processor,
 * a regulator. Behind the auth guard they would 307 to /sign-in and be useless to every one
 * of them — which is the same failure `/auth/callback` and the generated `/opengraph-image`
 * route each shipped once, and which is invisible in dev because the fixture flag returns
 * before the redirect.
 *
 * The claims themselves are checked in `apps/web/test/legal.server.test.ts`, against the
 * migrations rather than against the prose. This file is about the pages being reachable,
 * readable and accessible.
 */

const PAGES = [
  { path: '/privacy', title: 'Privacy' },
  { path: '/terms', title: 'Terms' },
] as const

for (const { path, title } of PAGES) {
  test(`${path} loads for someone with no account`, async ({ page }) => {
    const response = await page.goto(path)

    // A redirect would still resolve to a 200 on the destination, so the URL is the
    // assertion, not the status.
    expect(response?.status()).toBe(200)
    expect(new URL(page.url()).pathname).toBe(path)
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
  })

  test(`${path} says when it was last updated`, async ({ page }) => {
    // A policy with no date cannot be told apart from an abandoned one.
    await page.goto(path)
    await expect(page.getByText(/Last updated \d{1,2} \w+ \d{4}/)).toBeVisible()
  })

  test(`${path} has no em dash`, async ({ page }) => {
    await page.goto(path)
    expect(await page.locator('main').innerText()).not.toContain('—')
  })

  test(`${path} never scrolls sideways at 390px`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 })
    await page.goto(path)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
  })

  test(`${path} has no accessibility violations in either theme`, async ({ page }) => {
    for (const theme of ['dark', 'light'] as const) {
      await page.goto(path)
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()
      expect(results.violations, `${theme}: ${JSON.stringify(results.violations, null, 2)}`).toEqual(
        [],
      )
    }
  })

  test(`${path} anchors land on their section`, async ({ page }) => {
    await page.goto(path)
    const first = page.locator('nav a').first()
    const href = await first.getAttribute('href')
    await first.click()

    const target = page.locator(href ?? '#')
    await expect(target).toBeVisible()
    // scroll-margin keeps the heading clear of the sticky top bar. Without it the jump lands
    // the heading underneath the chrome, which reads as the link going somewhere else.
    const top = await target.evaluate((el) => el.getBoundingClientRect().top)
    expect(top).toBeGreaterThanOrEqual(0)
  })
}

test('the privacy policy refuses the claim CloakCal is not allowed to make', async ({ page }) => {
  await page.goto('/privacy')
  const text = await page.locator('main').innerText()

  // Rule 1, asserted on the rendered page rather than on the source: the phrase appears once
  // and the sentence it appears in denies it.
  expect(text.toLowerCase()).toContain('not zero-knowledge')
  // And the true claim is present and findable, not merely the false one absent.
  expect(text).toMatch(/times, durations|when your events happen/i)
})

test('the landing footer links to both, signed out', async ({ page }) => {
  // An unlinked policy is a policy nobody finds. The landing is where a stranger is, and
  // `?landing` is how the fixture reaches it.
  await page.goto('/?landing=1')

  const footer = page.locator('footer')
  await expect(footer.getByRole('link', { name: 'Privacy' })).toBeVisible()
  await expect(footer.getByRole('link', { name: 'Terms' })).toBeVisible()

  await footer.getByRole('link', { name: 'Privacy' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy' })).toBeVisible()
})

test('settings links to both, from inside the account', async ({ page }) => {
  // Someone deciding whether to KEEP trusting the product should not have to sign out to
  // re-read what they agreed to.
  await page.goto('/settings')
  await expect(page.getByRole('link', { name: 'Privacy' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Terms' })).toBeVisible()
})
