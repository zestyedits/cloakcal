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
