import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * "Is this the demo" and "does this account have an email" are two different questions, and
 * nothing may answer the first by asking the second.
 *
 * They gave the same answer for as long as the security flows lived inside a <details> card
 * on /settings, so `email === ''` served as the demo test and nobody minded. Extracting
 * those flows to /settings/security made that sentinel load-bearing for a whole route, and
 * the two facts come apart in a real case: Supabase's `user.email` is null for phone auth
 * and for OAuth identities that return no address, so a signed-in user would have been shown
 * "Demo. Sign in to manage your password" — while signed in, with nothing on screen to
 * suggest the page had simply misread them.
 *
 * Source-level for the usual reason: the fixture has no session at all, so no environment
 * here can produce a signed-in user with a null email, and a behavioural test would assert
 * the branch that already works while leaving the broken one uncovered.
 *
 * The screens take an explicit `demo` prop now. This forbids the shortcut coming back.
 *
 * A SWEEP RATHER THAN A LIST, since the settings accordion became four pages. This named two
 * files, one of which no longer exists, and the two new screens it should have covered would
 * have been added to the tree with nothing checking them — the orphan problem `playwright.
 * config.ts`'s testMatch and `packages/db/test/harness.ts` both have. Anything under
 * `components/settings/` that renders demo copy is in scope automatically.
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

const SECURITY_SCREEN = read('../src/components/settings/security-screen.tsx')
const SECURITY_PAGE = read('../src/app/settings/security/page.tsx')

/** Every settings component that renders demo copy at all, so a new screen is covered by
 *  existing rather than by being remembered. */
const SETTINGS_DIR = fileURLToPath(new URL('../src/components/settings/', import.meta.url))
const DEMO_SCREENS = readdirSync(SETTINGS_DIR)
  .filter((name) => name.endsWith('.tsx'))
  .map((name) => [name, readFileSync(join(SETTINGS_DIR, name), 'utf8')] as const)
  .filter(([, source]) => source.includes('Demo.'))

describe('the demo sentinel', () => {
  it('is an explicit flag on the security screen, passed by its page', () => {
    expect(SECURITY_SCREEN).toContain('demo: boolean')
    expect(SECURITY_PAGE).toContain('<SecurityScreen demo ')
    expect(SECURITY_PAGE).toContain('demo={false}')
  })

  it('never decides "demo" by testing the email for emptiness', () => {
    // An empty email is still a legitimate thing to BRANCH on — it means the flows below
    // cannot derive a key — but it must not be the thing that renders the demo copy.
    // Anti-vacuous: a sweep that found nothing would pass while checking nothing, which is
    // precisely how the list version would have failed once the files it named moved.
    expect(DEMO_SCREENS.length).toBeGreaterThan(2)

    for (const [name, source] of DEMO_SCREENS) {
      // [\s\S] rather than [^}]: the JSX between the two contains `{styles.lockedNote}`,
      // and a first draft that excluded braces matched nothing — passing against the very
      // source it was written to reject. Checked by running it against the old code.
      const demoNearEmptyEmail = /email === ''[\s\S]{0,200}Demo\./.test(source)
      expect(demoNearEmptyEmail, `${name} infers demo from an empty email`).toBe(false)
    }
  })

  it('still says something honest when a signed-in account has no email', () => {
    // The email is the KDF salt, so this is a real dead end rather than a rendering
    // accident, and the copy has to say which.
    expect(SECURITY_SCREEN).toContain('no email address')
  })
})
