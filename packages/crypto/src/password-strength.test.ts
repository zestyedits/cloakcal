import { describe, expect, it } from 'vitest'
import { assessPassword } from './password-strength.js'

/**
 * The only password check that can possibly work here.
 *
 * Supabase never sees the real password — only the Argon2id output — so every server-side
 * protection it offers is inert. Its leaked-password check would be comparing a 256-bit
 * derived secret against breach corpora and passing every time, including for "password".
 * Until this existed the only gate was `minLength={10}` on an HTML input.
 *
 * The stakes differ from an ordinary app: the password derives the key that decrypts the
 * content, so a weak one is not a weak lock on a strong box — it is the strength of the
 * encryption, grindable offline at the attacker's pace.
 */

describe('what it refuses outright', () => {
  it.each([
    ['empty', ''],
    ['short', 'hunter2'],
    ['eleven characters', 'abcdefghijk'],
  ])('blocks %s', (_label, password) => {
    expect(assessPassword(password).acceptable).toBe(false)
  })

  it('treats twelve as the floor, not eight', () => {
    // Eight is NIST's floor for a SERVER-verified secret, where rate limiting and lockout
    // exist. Neither is available against an offline attack on a wrap.
    expect(assessPassword('abcdefghijk').acceptable).toBe(false)
    expect(assessPassword('correct horse battery').acceptable).toBe(true)
  })
})

describe('what it warns about but allows', () => {
  it.each([
    ['a keyboard run', 'qwertyuiopasdf'],
    ['an obvious word', 'mypasswordisgood'],
    ['one repeated character', 'aaaaaaaaaaaaaaaa'],
  ])('flags %s without blocking a long password', (_label, password) => {
    const result = assessPassword(password)
    expect(result.problems.length).toBeGreaterThan(0)
    expect(result.verdict).toBe('weak')
    // Warn, do not refuse. A meter that rejects a password someone has already chosen and
    // written down teaches them to append "1!", which helps nobody.
    expect(result.acceptable).toBe(true)
  })

  it('catches a password built from the email, which is the KDF salt', () => {
    // An attacker targeting this account already has the address — it is the salt. A
    // password made from it adds nothing they do not already know.
    const result = assessPassword('keithguinn-2026!', 'keithguinn@example.com')
    expect(result.problems.join(' ')).toMatch(/email/i)
  })

  it('does not flag a short local part that appears by coincidence', () => {
    expect(assessPassword('a rambling passphrase', 'a@example.com').problems).toEqual([])
  })
})

describe('what it accepts quietly', () => {
  it.each([
    'correct horse battery staple',
    'Tp0!nted-Grange-Vole-77',
    'the quiet part out loud',
  ])('is happy with %s', (password) => {
    const result = assessPassword(password)
    expect(result.problems).toEqual([])
    expect(result.acceptable).toBe(true)
  })

  it('rewards length over punctuation, because that is what actually helps', () => {
    // Four random words beat one mangled word, and the scale should say so rather than
    // demanding a symbol.
    expect(assessPassword('P@ssw0rd1234').verdict).not.toBe('strong')
    expect(assessPassword('sixteencharacters').verdict).toBe('strong')
  })
})
