import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

/**
 * /contact.
 *
 * THE FIRST TEST IS THE ONE THAT MATTERS, for the same reason it is in `legal.spec.ts`: this
 * page exists for people who do NOT have a working session. Somebody locked out, a stranger
 * deciding whether to sign up, an app store reviewer, a regulator. Behind the auth guard it
 * would 307 to /sign-in, which for the locked-out user is the page they just failed at.
 *
 * The claims themselves are checked in `apps/web/test/legal-claims.server.test.ts`, which pairs
 * every "our contact page" sentence in the legal documents against `CONTACT_PATH` existing.
 * This file is about the page being reachable, readable, accessible, and honest about the two
 * things it cannot do.
 */

const PATH = '/contact'

test('loads for someone with no account', async ({ page }) => {
  const response = await page.goto(PATH)

  // A redirect still resolves to 200 on the destination, so the URL is the assertion.
  expect(response?.status()).toBe(200)
  expect(new URL(page.url()).pathname).toBe(PATH)
  await expect(page.getByRole('heading', { level: 1, name: 'Contact' })).toBeVisible()
})

test('prints the address as text, not only as a link target', async ({ page }) => {
  /*
   * THE ONE MECHANICAL WEAKNESS OF CHOOSING A MAILTO OVER A FORM, pinned so it cannot be
   * "tidied" away. A `mailto:` does nothing on a machine with no mail client registered, which
   * is most webmail users on a desktop, and the failure is silent: the click does not land and
   * the page just sits there. Rendering the address as the link's own LABEL is what makes
   * select-and-copy work anyway, so a link whose text became "Email us" would quietly remove
   * the only route those users have.
   */
  await page.goto(PATH)

  const link = page.getByRole('link', { name: 'hello@cloakcal.com' })
  await expect(link).toBeVisible()
  await expect(link).toHaveAttribute('href', 'mailto:hello@cloakcal.com?subject=CloakCal')

  // The address is IN the rendered text of the page, not merely in an href.
  expect(await page.locator('main').innerText()).toContain('hello@cloakcal.com')
})

test('offers the two purpose-built subjects, encoded', async ({ page }) => {
  // Encoded, because a bare space in a `mailto:` query survives most clients and is still
  // wrong, and the moment a subject gains an ampersand an unencoded one truncates silently.
  await page.goto(PATH)

  await expect(page.getByRole('link', { name: 'Start a deletion request' })).toHaveAttribute(
    'href',
    'mailto:hello@cloakcal.com?subject=Delete%20my%20account',
  )
  await expect(page.getByRole('link', { name: 'Report a security issue' })).toHaveAttribute(
    'href',
    'mailto:hello@cloakcal.com?subject=Security',
  )
})

test('promises no response time and no support team', async ({ page }) => {
  /*
   * THE HONESTY GATE FOR THIS PAGE, and the reason it is asserted rather than reviewed: "we
   * aim to reply within 24 hours" is the sentence every product this size writes, none of them
   * can keep, and any future edit here would add without thinking. There is one person and no
   * rota. An unkept promise on a page whose whole job is being believed is worse than silence,
   * and this repo has already paid for exactly that with the export sentence.
   */
  await page.goto(PATH)
  const text = await page.locator('main').innerText()

  for (const overclaim of [
    /within \d+ (?:hours?|business days?|days?)/i,
    /we (?:aim to |try to |will )?(?:reply|respond|get back)/i,
    // "no support team" is what the copy says and is fine. An article in front of it is the
    // claim, which is why these name the determiner rather than the noun.
    /(?:a|our|the) support team/i,
    /24\/7/,
    /our team will/i,
    /as soon as possible/i,
  ]) {
    const found = text.match(overclaim)?.[0]
    expect(found, `the contact page promises "${found ?? ''}"`).toBeUndefined()
  }

  // Positive half, so this cannot pass by the page failing to render.
  expect(text).toMatch(/no support team/i)
  expect(text).toMatch(/no ticket queue/i)
})

test('leads with the thing email cannot fix', async ({ page }) => {
  /*
   * The single likeliest reason a stranger writes to a product like this one is that they are
   * locked out, and the honest answer is that no amount of email recovers a lost key. Ordering
   * that ahead of the friendlier sections is a design decision, so it is asserted as one: a
   * later edit that buries it under "we would love to hear from you" costs somebody a day of
   * hoping.
   */
  await page.goto(PATH)
  const text = await page.locator('main').innerText()

  expect(text).toMatch(/cannot get your calendar back/i)
  expect(text).toMatch(/never send us your password or your recovery phrase/i)

  const cannot = text.search(/What writing to us cannot do/i)
  const expectations = text.search(/What to expect/i)
  expect(cannot).toBeGreaterThan(-1)
  expect(expectations).toBeGreaterThan(cannot)
})

test('says email is not encrypted the way the calendar is', async ({ page }) => {
  // Rule 1 applied to this page. Somebody who chose CloakCal will reasonably assume writing to
  // us is sealed too. It is not, and the page has to say so rather than let the assumption run.
  await page.goto(PATH)
  const text = await page.locator('main').innerText()

  expect(text).toMatch(/arrives readable|is not the calendar/i)
  // And it must not make the claim CloakCal is never allowed to make.
  expect(text.toLowerCase()).not.toContain('zero-knowledge')
})

test('has no em dash', async ({ page }) => {
  await page.goto(PATH)
  expect(await page.locator('main').innerText()).not.toContain('—')
})

test('never scrolls sideways at 390px', async ({ page }) => {
  // A long unbreakable address is exactly the shape that overflows a narrow viewport, which is
  // why `.addressLink` carries `overflow-wrap: anywhere`. This is the guard for that.
  await page.setViewportSize({ width: 390, height: 800 })
  await page.goto(PATH)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
})

test('gives the address and the two actions a 44px target', async ({ page }) => {
  /*
   * Scoped to the three controls rather than to every `a[href]` on the page. The links inside
   * running prose deliberately do NOT take the floor — a 44px inline target opens a visible
   * hole in the middle of a paragraph — and `contact.module.css` states that trade beside the
   * rule. Every destination those inline links offer is also in the footers, which do.
   */
  await page.goto(PATH)

  for (const name of [
    'hello@cloakcal.com',
    'Start a deletion request',
    'Report a security issue',
  ]) {
    const box = await page.getByRole('link', { name }).boundingBox()
    expect(box?.height ?? 0, `${name} is under the touch floor`).toBeGreaterThanOrEqual(44)
  }
})

test('has no accessibility violations in either theme', async ({ page }) => {
  // Both themes, because every contrast failure this project has actually shipped was found in
  // LIGHT and was invisible in dark. Nothing on this page animates, so no settle is needed.
  for (const theme of ['dark', 'light'] as const) {
    await page.goto(PATH)
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(
      results.violations.map((v) => `${v.id}: ${v.help}`),
      theme,
    ).toEqual([])
  }
})

/*
 * ---------------------------------------------------------------------------
 * REACHABILITY. An unlinked contact page is the same defect as an unlinked privacy policy, and
 * the surfaces below are every place a person can be standing when they need one.
 * ---------------------------------------------------------------------------
 */

test('the landing footer carries it, signed out', async ({ page }) => {
  // A prospective user with a question had nowhere to ask it: the address lived only on a
  // settings page behind a sign-up that is not open.
  await page.goto('/?landing=1')

  const link = page.locator('footer').getByRole('link', { name: 'Contact' })
  await expect(link).toBeVisible()
  await link.click()
  await expect(page.getByRole('heading', { level: 1, name: 'Contact' })).toBeVisible()
})

test('every auth page carries it, which is where somebody is actually stuck', async ({ page }) => {
  /*
   * THE GAP THIS WORK EXISTED TO CLOSE, at its worst point. A person who cannot get past
   * /sign-in has no route to a human anywhere in the product: settings is behind the guard
   * they just failed, and the address was printed only on a page they cannot reach.
   */
  for (const path of ['/sign-in', '/sign-up', '/recover']) {
    await page.goto(path)
    const link = page.locator('footer').getByRole('link', { name: 'Contact' })
    await expect(link, `${path} has no contact link`).toBeVisible()

    // 44px, the lesson the landing footer already paid for.
    const box = await link.boundingBox()
    expect(box?.height ?? 0, `${path} contact link is under the touch floor`).toBeGreaterThanOrEqual(
      44,
    )
  }
})

test('both legal pages link to it, since both tell the reader to email us', async ({ page }) => {
  // The privacy policy said "email us" three times and named nowhere; the terms printed the
  // address inline once. A true instruction the reader cannot act on is the export sentence's
  // defect in its milder form.
  for (const path of ['/privacy', '/terms']) {
    await page.goto(path)
    await expect(
      page.getByRole('link', { name: 'Contact us' }),
      `${path} does not link to contact`,
    ).toBeVisible()
  }
})

test('settings carries it, from inside the account', async ({ page }) => {
  // Somebody who needs to delete their account is signed in, and this is where they look.
  await page.goto('/settings')
  await expect(page.getByRole('link', { name: 'Contact us' })).toBeVisible()
})

test('the deletion section links to it beside the mailto', async ({ page }) => {
  /*
   * The mailto on /settings/security was the ONLY route out of the product, and a mailto that
   * opens nothing fails silently. The contact page beside it is the fallback for exactly that.
   */
  await page.goto('/settings/security')
  await expect(page.getByRole('link', { name: 'Contact page' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'hello@cloakcal.com' })).toHaveAttribute(
    'href',
    'mailto:hello@cloakcal.com?subject=Delete%20my%20account',
  )
})
