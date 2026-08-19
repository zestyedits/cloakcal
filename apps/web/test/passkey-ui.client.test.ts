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
    const prfAt = CLOAK_SESSION.indexOf('await registerPasskey({')
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
    // Named, not just typed: `useState<string | null>(null)` alone also matches `error` and
    // `notice`, so reverting `working` to a boolean would have left this green.
    expect(UNLOCK_PANEL).toMatch(/const \[working, setWorking\] = useState<string \| null>/u)
    expect(UNLOCK_PANEL).toContain("setWorking('Waiting for your passkey')")
  })

  it('does not wipe a typed password when a passkey attempt is cancelled', () => {
    // The submit path clears both fields in its finally. The passkey path must not, or
    // cancelling a prompt discards what the user was halfway through typing.
    const from = UNLOCK_PANEL.indexOf('const runPasskey')
    const to = UNLOCK_PANEL.indexOf('const submit')
    // Both markers must exist AND be in this order, or the slice is empty and `not.toContain`
    // passes while checking nothing.
    expect(from).toBeGreaterThan(-1)
    expect(to).toBeGreaterThan(from)
    expect(UNLOCK_PANEL.slice(from, to)).not.toContain("setPassword('')")
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

  it('applies the passkey default ONCE, so it cannot stomp a choice mid-submit', () => {
    // onAuthStateChange fires on token refresh AND on USER_UPDATED, which rewrapPasswordWrap
    // itself emits. Re-running the default there flipped `proof` back to 'passkey' while the
    // user's chosen phrase was still being processed, swapping the page's story out from
    // under them at the exact moment they might reload.
    expect(RECOVER_FORM).toContain('if (proofDefaulted.current) return')
    // And an explicit choice always wins over the async default, which can land later.
    expect(RECOVER_FORM).toContain('if (!proofTouched.current) setProof')
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
    const from = SECURITY_SCREEN.indexOf('{demo ? (')
    const to = SECURITY_SCREEN.indexOf('!signedIn ? (')
    // Without these, a renamed marker gives indexOf -1, slice(a, -1) returns the rest of the
    // file — which contains the SIGNED-IN PasskeysSection — and the test passes vacuously
    // while the demo branch has nothing in it.
    expect(from).toBeGreaterThan(-1)
    expect(to).toBeGreaterThan(from)
    expect(SECURITY_SCREEN.slice(from, to)).toContain('<PasskeysSection')
  })
})
