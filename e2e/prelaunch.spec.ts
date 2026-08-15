import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

/**
 * Sign-ups closed. Every Playwright project runs without
 * NEXT_PUBLIC_CLOAKCAL_SIGNUPS_OPEN, so the closed state is what the suite sees by
 * default — which is the state that will be live until launch day.
 */

test('/sign-up offers a notice instead of a form', async ({ page }) => {
  await page.goto('/sign-up')

  await expect(page.getByRole('heading', { name: 'Not open yet' })).toBeVisible()
  // The point of the gate: no control that looks like it would work.
  await expect(page.getByRole('button', { name: 'Create account' })).toHaveCount(0)
  await expect(page.getByLabel('Email')).toHaveCount(0)
  await expect(page.getByLabel('Password')).toHaveCount(0)
})

test('the notice still offers the two things that work', async ({ page }) => {
  await page.goto('/sign-up')

  await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
    'href',
    '/sign-in',
  )
  await expect(page.getByRole('link', { name: 'Back to the front page' })).toHaveAttribute(
    'href',
    '/',
  )
})

test('sign-in still works and drops its dead-end invitation', async ({ page }) => {
  await page.goto('/sign-in')

  // The door Keith still needs.
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await expect(page.getByLabel('Email')).toBeVisible()

  await expect(page.getByText('New accounts are not open yet.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Create one' })).toHaveCount(0)
  // Recovery is unrelated to sign-ups and must survive the gate.
  await expect(page.getByRole('link', { name: 'Forgot your password?' })).toBeVisible()
})

test('the notice page scans clean', async ({ page }) => {
  await page.goto('/sign-up')
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])
})

/**
 * /recover had NO end-to-end coverage at all, on a product whose recovery flow is the one
 * people reach on their worst day. Its signed-out half needs no session, so there was never
 * a reason for the gap beyond nobody having written it.
 *
 * Filed here rather than in a recover.spec.ts because the device projects use an explicit
 * testMatch allowlist and a spec named in neither copy of that regex is collected by no
 * project and silently never runs. prelaunch is already listed.
 */
test('recovery asks for an email before it asks for anything secret', async ({ page }) => {
  await page.goto('/recover')

  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Email me a link' })).toBeVisible()

  // The phrase field must NOT be on this screen. Handing over 24 words before the link has
  // proved it reached the inbox is the whole thing this two-step flow exists to prevent.
  await expect(page.getByLabel(/recovery phrase/i)).toHaveCount(0)
})

test('a dead recovery link says which of the two things went wrong', async ({ page }) => {
  // GoTrue reports an unusable link in the FRAGMENT even under PKCE, so this is the shape a
  // real expired link arrives in.
  await page.goto('/recover#error=access_denied&error_description=Email+link+is+invalid')
  await expect(page.getByText(/expired or was already used/)).toBeVisible()

  // A code that fails to exchange means a different browser, which is a different fix, and
  // saying "expired" there would send someone to request another link that fails the same
  // way, forever.
  await page.goto('/recover?code=not-a-real-code')
  await expect(page.getByText(/same browser that asked for it/)).toBeVisible()
})

test('the recovery page scans clean', async ({ page }) => {
  await page.goto('/recover')
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])
})
