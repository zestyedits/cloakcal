import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The landing page must READ the sign-ups flag, not hardcode the door's state.
 *
 * Until 2026-08-18 it hardcoded it. `landing.tsx` never imported `signupsOpen`, so
 * "Coming soon" and "New accounts open soon." were literals: flipping
 * NEXT_PUBLIC_CLOAKCAL_SIGNUPS_OPEN opened `/sign-up` while the front page went on saying
 * the opposite, and offered no route to it. The failure is quiet in the direction that
 * matters, because opening the door is a redeploy nobody re-reads the marketing copy after.
 *
 * This is a SOURCE sweep rather than a browser test on purpose. The flag is NEXT_PUBLIC_ and
 * therefore inlined at build time, so exercising the open branch in Playwright would need a
 * second build of the whole app to assert one paragraph. Every project already runs closed
 * (see e2e/prelaunch.spec.ts), which means the open branch is exactly the one nothing else
 * here can see.
 *
 * Same family as `auth-buttons.server.test.ts` and `plan-badge.server.test.ts`: a comment did
 * not stop this the first time.
 */

const source = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), 'utf8')

describe('the landing page and the sign-ups flag', () => {
  const landing = source('components/landing.tsx')

  it('consults the flag rather than assuming a state', () => {
    expect(landing).toContain("from '@/lib/signups'")
    expect(landing).toContain('signupsOpen()')
  })

  it('puts every string that names the door behind that flag', () => {
    // Both literals survive — they are still the closed copy. What must be true is that
    // neither one is reachable unconditionally, which here means the file branches on the
    // flag it read. A literal with no branch anywhere is the regression this catches.
    for (const literal of ['Coming soon', 'New accounts open soon.']) {
      expect(landing, `"${literal}" is still in the landing copy`).toContain(literal)
    }
    expect(landing).toMatch(/\bopen \?|\bopen &&/)
  })

  it('offers a way to sign up once the door is open', () => {
    // The other half of the same defect: reading the flag but rendering nothing new for it
    // would leave the page merely quieter about being closed, with still no route onward.
    expect(landing).toContain('href="/sign-up"')
  })
})
