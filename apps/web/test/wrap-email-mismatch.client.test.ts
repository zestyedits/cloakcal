import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { WrapEmailMismatchError } from '../src/lib/cloak-session'

/**
 * A wrap that cannot be opened because the EMAIL changed must say so.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * The account email is the KDF salt, so a changed address derives a different wrapping key
 * and the stored wrap stops opening. Nothing in the failure distinguishes that from a
 * mistyped password: both end at a failed AES-GCM tag, which is a label that simply does
 * not open. The user is told "that password did not open your calendar", concludes they
 * typed it wrong, and tries harder at something that cannot work.
 *
 * `kdf.saltEmail` has recorded the address each wrap was derived under for months, and
 * NOTHING read it back. The one clue deliberately kept was never shown to the only person
 * who needed it.
 *
 * ADR 0006 proposed removing the email from the salt altogether and is REJECTED: the salt
 * is needed to derive the auth secret, which is a precondition of having a session, so a
 * salt stored server-side is unreachable at the moment it is required. We cannot remove the
 * hazard. Naming it is the remainder, and this test is what keeps it named.
 *
 * ---------------------------------------------------------------------------
 * WHY PART OF IT IS A SOURCE-LEVEL TEST
 * ---------------------------------------------------------------------------
 *
 * Reaching `unwrapWithPassword` needs a real Supabase session and a real stored wrap, which
 * is the manual throwaway-account recipe in CLAUDE.md and cannot run in CI. Same reasoning
 * as recovery-unlocks and signup-enumeration: when the behaviour cannot be observed
 * deterministically, pin the mechanism instead of pretending to test the outcome.
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

const CLOAK_SESSION = read('../src/lib/cloak-session.ts')
const AUTH_FORM = read('../src/components/auth-form.tsx')
const CHANGE_PASSWORD = read('../src/components/change-password.tsx')

describe('WrapEmailMismatchError', () => {
  it('names the address the key was actually derived under', () => {
    const error = new WrapEmailMismatchError('old@example.test')
    // Without the address the message is just a longer way of saying "it did not work".
    // The address IS the actionable part: it tells the user which account to sign in as.
    expect(error.message).toContain('old@example.test')
    expect(error.wrappedUnder).toBe('old@example.test')
  })

  it('offers the way out, not just the diagnosis', () => {
    const error = new WrapEmailMismatchError('old@example.test')
    expect(error.message).toMatch(/recovery phrase/iu)
  })
})

describe('the password unwrap path', () => {
  it('checks the recorded salt email before it blames the password', () => {
    const mismatchAt = CLOAK_SESSION.indexOf('throw new WrapEmailMismatchError')
    const wrongPasswordAt = CLOAK_SESSION.indexOf('throw new WrongPasswordError')
    expect(mismatchAt).toBeGreaterThan(-1)
    // Order is the whole point. WrongPasswordError is the fallback for causes we cannot
    // name; reaching it first would make the specific diagnosis unreachable.
    expect(mismatchAt).toBeLessThan(wrongPasswordAt)
  })

  it('claims a mismatch only when one was RECORDED', () => {
    // Wraps written before `saltEmail` existed carry no address, and inferring one would be
    // guessing — it would tell a user with a perfectly good password that their account
    // belongs to some other email. Absent must mean "say nothing", never "assume".
    expect(CLOAK_SESSION).toContain('wrappedUnder !== null')
  })

  it('compares normalised addresses, since that is what the salt is built from', () => {
    // deriveMasterSecret salts with normalizeAccountEmail(email). Comparing raw input
    // against a normalised record would report a mismatch for ` A@B.C ` versus `a@b.c` —
    // a false alarm on the exact path that exists to stop false alarms.
    expect(CLOAK_SESSION).toMatch(/wrappedUnder !== normalizeAccountEmail\(email\)/u)
  })
})

describe('the surfaces that show it', () => {
  it('is named in auth-form BEFORE the message-matching ladder', () => {
    const namedAt = AUTH_FORM.indexOf('caught instanceof WrapEmailMismatchError')
    const firstRegexAt = AUTH_FORM.indexOf('invalid login credentials')
    expect(namedAt).toBeGreaterThan(-1)
    // Those patterns match on message TEXT, which is right for Supabase's strings and wrong
    // for ours: a typed error that already says the right thing must not be at the mercy of
    // a substring match written for something else.
    expect(namedAt).toBeLessThan(firstRegexAt)
  })

  it('is carried through change-password rather than flattened', () => {
    expect(CHANGE_PASSWORD).toContain('caught instanceof WrapEmailMismatchError')
  })
})
