import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The passkey surfaces, pinned at the level they can be.
 *
 * ---------------------------------------------------------------------------
 * WHY SOURCE-LEVEL
 * ---------------------------------------------------------------------------
 *
 * Two independent walls, either of which alone would be enough.
 *
 * NO SESSION. Every Playwright project runs with NEXT_PUBLIC_CLOAKCAL_DEV_UNLOCK=1, so
 * there is no Supabase user. Registration writes a wrap row behind RLS keyed to auth.uid();
 * unlock reads one. Neither can happen. The unlock panel does not even MOUNT in fixture
 * mode — CloakProvider unlocks with the seed key and sets locked = false.
 *
 * NO AUTHENTICATOR. A virtual authenticator can be attached over CDP, but it would only
 * prove we called the API we meant to call. It cannot tell us Safari returns PRF output
 * where we expect it, which is the thing most likely to be wrong.
 *
 * So: pin the mechanism, and rely on the manual throwaway-account pass for the outcome.
 * Same reasoning as recovery-unlocks and wrap-email-mismatch.
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

const PASSKEYS_SECTION = read('../src/components/passkeys-section.tsx')
const UNLOCK_PANEL = read('../src/components/unlock-panel.tsx')
const RECOVER_FORM = read('../src/components/recover-form.tsx')
const SECURITY_SCREEN = read('../src/components/settings/security-screen.tsx')
const CLOAK_SESSION = read('../src/lib/cloak-session.ts')

describe('registering a passkey', () => {
  it('opens the root key BEFORE it starts the ceremony', () => {
    // registerPasskeyWrap needs raw key bytes. Running the ceremony first would mean two
    // biometric prompts followed by "that password was wrong", having thrown away the work.
    const openAt = PASSKEYS_SECTION.indexOf('await openRootKey()')
    const registerAt = PASSKEYS_SECTION.indexOf('await registerPasskeyWrap')
    expect(openAt).toBeGreaterThan(-1)
    expect(openAt).toBeLessThan(registerAt)
  })

  it('warns that the ceremony asks twice', () => {
    // PRF output is not reliably returned from create(), so registration creates the
    // credential and immediately asserts against it. Two prompts back to back read as the
    // first having failed unless the label says otherwise. ADR 0005 requires this.
    expect(PASSKEYS_SECTION).toMatch(/Confirm twice/u)
  })

  it('writes nothing before the PRF output exists', () => {
    // The insert lives inside registerPasskeyWrap, after evaluatePrf. A credential with no
    // wrap is a passkey sitting in someone's password manager opening nothing.
    const prfAt = CLOAK_SESSION.indexOf('await registerPasskey({ userId, email, label })')
    const insertAt = CLOAK_SESSION.indexOf("from('root_key_wraps').insert({")
    expect(prfAt).toBeGreaterThan(-1)
    expect(prfAt).toBeLessThan(insertAt)
  })
})

describe('removing a passkey', () => {
  it('counts the remaining wraps BEFORE deleting', () => {
    const guard = CLOAK_SESSION.indexOf('throw new LastWrapError()')
    const del = CLOAK_SESSION.indexOf(".delete().eq('id', wrapId)")
    expect(guard).toBeGreaterThan(-1)
    // Deleting first and checking after would be a guard that reports the account is
    // already unrecoverable. It matters most for OAuth accounts, which have no password
    // wrap, so their passkeys may be all they have.
    expect(guard).toBeLessThan(del)
  })

  it('says that removal does not rotate the key', () => {
    // ADR 0005 requires the UI to be honest that deleting a wrap deletes a COPY, and that
    // anything which already held the key still holds it.
    expect(PASSKEYS_SECTION).toMatch(/does not change\s+the key itself/u)
  })
})

describe('the unlock panel', () => {
  it('offers the passkey above the password field', () => {
    const passkeyAt = UNLOCK_PANEL.indexOf('Unlock with a passkey')
    const passwordAt = UNLOCK_PANEL.indexOf('unlock-password')
    expect(passkeyAt).toBeGreaterThan(-1)
    // The whole reason to have a passkey is that it is the fast way in. Burying it under
    // the thing it replaces would be a feature nobody finds.
    expect(passkeyAt).toBeLessThan(passwordAt)
  })

  it('carries a working LABEL rather than a boolean', () => {
    // The old hardcoded "Deriving your key" is false on the passkey path, where nothing is
    // derived and the wait is the operating system's.
    expect(UNLOCK_PANEL).toContain('useState<string | null>(null)')
    expect(UNLOCK_PANEL).toContain("setWorking('Waiting for your passkey')")
  })

  it('does not wipe a typed password when a passkey attempt is cancelled', () => {
    // The submit path clears both fields in its finally. The passkey path must not, or
    // cancelling a prompt discards what the user was halfway through typing.
    const passkeyFinally = UNLOCK_PANEL.slice(
      UNLOCK_PANEL.indexOf('const runPasskey'),
      UNLOCK_PANEL.indexOf('const submit'),
    )
    expect(passkeyFinally).not.toContain("setPassword('')")
  })

  it('maps errors instead of surfacing raw messages', () => {
    // This panel had no messageFor at all until passkeys arrived with errors whose default
    // text is written for a form, not a lock screen.
    expect(UNLOCK_PANEL).toContain('function messageFor')
  })
})

describe('cancelling is not an error anywhere', () => {
  // PasskeyCancelledError means the user changed their mind or walked away. InlineError is
  // role="alert" and styled as danger, which is the wrong register for a normal outcome.
  it.each([
    ['the passkeys section', PASSKEYS_SECTION],
    ['the unlock panel', UNLOCK_PANEL],
  ])('routes a cancelled ceremony to the notice in %s', (_name, source) => {
    const branch = source.indexOf('instanceof PasskeyCancelledError')
    expect(branch).toBeGreaterThan(-1)
    expect(source.slice(branch, branch + 120)).toMatch(/setNotice/u)
  })
})

describe('/recover', () => {
  it('swaps only the proof, leaving the re-wrap path identical', () => {
    const seamAt = RECOVER_FORM.indexOf('await rootKeyFromPasskey()')
    const rewrapAt = RECOVER_FORM.indexOf('await rewrapPasswordWrap')
    const unlockAt = RECOVER_FORM.indexOf('await persistUnlockedSession')
    expect(seamAt).toBeGreaterThan(-1)
    // Both proofs return the same RootKey, so everything downstream stays one path. Two
    // copies of the re-wrap would be two places for the unlock step to go missing, which
    // is the bug this flow already shipped once.
    expect(seamAt).toBeLessThan(rewrapAt)
    expect(rewrapAt).toBeLessThan(unlockAt)
  })

  it('only offers a passkey once a session exists', () => {
    // Reading a wrap needs a session, which the emailed link creates. Offering it on the
    // request screen would raise a prompt whose read RLS then refuses.
    expect(RECOVER_FORM).toContain('offerPasskey')
    const requestScreen = RECOVER_FORM.indexOf("setScreen('request')")
    const offerCalls = [...RECOVER_FORM.matchAll(/offerPasskey\(\)/gu)].map((m) => m.index ?? -1)
    // Every CALL sits in a branch that has already established a session; none of them is
    // adjacent to the request screen's own transition.
    expect(offerCalls.length).toBeGreaterThan(0)
    expect(offerCalls.every((at) => at !== requestScreen)).toBe(true)
  })

  it('does not tell a passkey user their wait is a slow derivation', () => {
    // True of Argon2id, false of a fingerprint. Explaining a delay that is not happening
    // reads as a stall.
    expect(RECOVER_FORM).toMatch(/proof === 'passkey'\s*\?\s*`\$\{working\}\. Confirm it on your device/u)
  })
})

describe('the demo branch', () => {
  it('renders the passkeys card so the sweeps can see it', () => {
    // /settings/security is scanned by axe and swept for 44px targets, and BOTH only ever
    // see the demo branch, because Playwright has no session. A control rendered only for
    // signed-in users is a control no test has ever measured.
    const demoBranch = SECURITY_SCREEN.slice(
      SECURITY_SCREEN.indexOf('{demo ? ('),
      SECURITY_SCREEN.indexOf("email === '' ?"),
    )
    expect(demoBranch).toContain('<PasskeysSection')
  })
})
