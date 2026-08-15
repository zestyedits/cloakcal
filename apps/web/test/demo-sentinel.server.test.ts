import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

const SECURITY_SCREEN = read('../src/components/settings/security-screen.tsx')
const SETTINGS_SCREEN = read('../src/components/settings/settings-screen.tsx')
const SECURITY_PAGE = read('../src/app/settings/security/page.tsx')

describe('the demo sentinel', () => {
  it('is an explicit flag on the security screen, passed by its page', () => {
    expect(SECURITY_SCREEN).toContain('demo: boolean')
    expect(SECURITY_PAGE).toContain('<SecurityScreen demo ')
    expect(SECURITY_PAGE).toContain('demo={false}')
  })

  it('never decides "demo" by testing the email for emptiness', () => {
    // An empty email is still a legitimate thing to BRANCH on — it means the flows below
    // cannot derive a key — but it must not be the thing that renders the demo copy.
    for (const [name, source] of [
      ['security-screen.tsx', SECURITY_SCREEN],
      ['settings-screen.tsx', SETTINGS_SCREEN],
    ] as const) {
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
