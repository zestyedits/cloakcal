import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Finishing recovery must leave the browser UNLOCKED.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS PINS, WHICH SHIPPED AND SURVIVED REVIEW
 * ---------------------------------------------------------------------------
 *
 * `/recover` opened the root key with the 24-word phrase, re-wrapped it to the new
 * password, and navigated to the calendar under a comment reading "the session is valid and
 * the key is already open". The key was not open. `rootKeyFromRecoveryPhrase` only unwraps;
 * nothing on that path ever called `rememberSessionKey`, which happens exclusively inside
 * `finishUnlock`. So a user who had just typed twenty-four words and chosen a new password
 * arrived at the unlock panel and was asked to authenticate all over again — the single
 * worst moment in this product to hit a dead end, on the one flow people reach when they are
 * already having a bad day.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A SOURCE-LEVEL TEST
 * ---------------------------------------------------------------------------
 *
 * Observing it needs a real Supabase session, a real emailed PKCE link and a real 24-word
 * phrase belonging to a real account — the throwaway-account recipe in CLAUDE.md, which is
 * a manual pass by construction and cannot run in CI. The fixture has no session at all, so
 * no Playwright project can reach this path. Same reasoning as signup-enumeration and
 * loading-shell: when the behaviour cannot be observed deterministically, pin the mechanism.
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

const RECOVER_FORM = read('../src/components/recover-form.tsx')
const CLOAK_SESSION = read('../src/lib/cloak-session.ts')

describe('the recovery reset path', () => {
  it('persists the unlocked session before it navigates away', () => {
    expect(RECOVER_FORM).toContain('persistUnlockedSession')

    // Order matters and is the whole point: unlocking after the redirect would race the
    // navigation, and unlocking before the re-wrap would persist a key the new password
    // cannot open if the re-wrap then fails.
    const unlockAt = RECOVER_FORM.indexOf('await persistUnlockedSession')
    const rewrapAt = RECOVER_FORM.indexOf('await rewrapPasswordWrap')
    const navigateAt = RECOVER_FORM.indexOf('router.replace')
    expect(rewrapAt).toBeGreaterThan(-1)
    expect(unlockAt).toBeGreaterThan(rewrapAt)
    expect(navigateAt).toBeGreaterThan(unlockAt)
  })

  it('routes every unlock through the one function that writes the vault', () => {
    // `rememberSessionKey` is what makes a session survive a reload, and it is called from
    // exactly one place. A second call site is how one route comes to forget it — which is
    // precisely what happened here.
    expect(CLOAK_SESSION).toContain('export async function persistUnlockedSession')
    const vaultWrites = CLOAK_SESSION.match(/rememberSessionKey\(/g) ?? []
    expect(vaultWrites.length).toBe(1)
  })
})
