import { describe, expect, it } from 'vitest'
import {
  CURRENT_KDF_PARAMS,
  createRootKey,
  deriveMasterSecret,
  deriveRecoveryWrapKey,
  deriveWrapKey,
  generateRecoveryPhrase,
  unwrapRootKey,
  wrapRootKey,
} from './index.js'

/**
 * Changing a password, at the level where it is only mathematics.
 *
 * The application half of this lives in apps/web (rewrapPasswordWrap) and is tested there
 * with a fake Supabase. What these tests own is the claim the whole feature rests on:
 *
 *   THE ROOT KEY NEVER CHANGES. Only the wrapper around it does.
 *
 * That is why a password change does not re-encrypt a single event, why it takes the same
 * time for a user with ten events and one with ten thousand, and why the recovery phrase
 * keeps working afterwards. If that claim were false the feature would be a migration, not
 * a rotation, and would need an entirely different design.
 *
 * A slow file by construction: each Argon2id derivation is deliberately expensive, so the
 * password count here is kept to the minimum that proves the property.
 */

const EMAIL = 'keith@example.test'
const OLD = 'correct horse battery staple'
const NEW = 'a different password entirely'

const wrapKeyFor = async (password: string, email = EMAIL) =>
  deriveWrapKey(await deriveMasterSecret(password, email, CURRENT_KDF_PARAMS))

describe('re-wrapping the root key under a new password', () => {
  it('keeps the same root key, so nothing has to be re-encrypted', async () => {
    const rootKey = createRootKey()

    const before = await wrapRootKey(rootKey, await wrapKeyFor(OLD), 'password')
    const after = await wrapRootKey(rootKey, await wrapKeyFor(NEW), 'password')

    const opened = await unwrapRootKey(after, await wrapKeyFor(NEW))
    expect([...opened.bytes]).toEqual([...rootKey.bytes])

    // The stored bytes differ — same key, different wrapper — which is the whole point.
    expect([...after.wrapped]).not.toEqual([...before.wrapped])
  })

  it('stops the old password opening the new wrap', async () => {
    const rootKey = createRootKey()
    const after = await wrapRootKey(rootKey, await wrapKeyFor(NEW), 'password')

    await expect(unwrapRootKey(after, await wrapKeyFor(OLD))).rejects.toThrow()
  })

  it('leaves the recovery phrase working, because it wraps the same unchanged key', async () => {
    // The failure this rules out is the one that would matter most: a password change that
    // silently invalidated the phrase, discovered only by someone who had already lost their
    // password and had nothing else left.
    const rootKey = createRootKey()
    const phrase = generateRecoveryPhrase()

    const recoveryWrap = await wrapRootKey(rootKey, await deriveRecoveryWrapKey(phrase), 'recovery')
    // ... a password change happens, touching only the password wrap ...
    await wrapRootKey(rootKey, await wrapKeyFor(NEW), 'password')

    const opened = await unwrapRootKey(recoveryWrap, await deriveRecoveryWrapKey(phrase))
    expect([...opened.bytes]).toEqual([...rootKey.bytes])
  })

  it('cannot be opened by the new password under a different email', async () => {
    // The email is the KDF salt, so an address change is as destructive as a password change
    // and is currently unhandled — there is no email-change UI, and this test is here to
    // make the consequence explicit if one is ever added. See the salt note in CLAUDE.md.
    const rootKey = createRootKey()
    const after = await wrapRootKey(rootKey, await wrapKeyFor(NEW), 'password')

    await expect(
      unwrapRootKey(after, await wrapKeyFor(NEW, 'someone.else@example.test')),
    ).rejects.toThrow()
  })

  it('treats email case and padding as the same address, so a rewrap is not lost to typing', async () => {
    const rootKey = createRootKey()
    const after = await wrapRootKey(rootKey, await wrapKeyFor(NEW), 'password')

    const opened = await unwrapRootKey(after, await wrapKeyFor(NEW, '  Keith@Example.TEST '))
    expect([...opened.bytes]).toEqual([...rootKey.bytes])
  })
})

/**
 * Rotating the RECOVERY phrase — the mirror image, and the one that closes a real trap.
 *
 * Until `reissueRecoveryPhrase` existed there was no way to get a new set of 24 words. Losing
 * the paper while still signed in left the account already unrecoverable and looking
 * completely fine, with the failure surfacing on the one day it could no longer be fixed.
 *
 * The same claim underwrites this as underwrites a password change — the root key does not
 * move — plus one that does not apply there: THE OLD PHRASE MUST STOP WORKING. A password
 * change is about convenience; a phrase rotation is often about someone else having seen the
 * words, and a rotation that left the old set valid would answer the wrong problem while
 * looking like it had answered the right one.
 */
describe('re-issuing the recovery phrase', () => {
  it('opens under the new phrase and refuses the old one', async () => {
    const rootKey = createRootKey()
    const first = generateRecoveryPhrase()
    const second = generateRecoveryPhrase()
    expect(second).not.toBe(first)

    // What the account starts with.
    const before = await wrapRootKey(rootKey, await deriveRecoveryWrapKey(first), 'recovery')
    // What rotation replaces it with. One row, overwritten — there is no second recovery wrap.
    const after = await wrapRootKey(rootKey, await deriveRecoveryWrapKey(second), 'recovery')

    const opened = await unwrapRootKey(after, await deriveRecoveryWrapKey(second))
    expect([...opened.bytes]).toEqual([...rootKey.bytes])

    // The old words against the new wrap: whoever found the lost paper is now locked out.
    await expect(unwrapRootKey(after, await deriveRecoveryWrapKey(first))).rejects.toThrow()

    // And the reverse, so the test cannot pass by both wraps simply being broken.
    const stillOpens = await unwrapRootKey(before, await deriveRecoveryWrapKey(first))
    expect([...stillOpens.bytes]).toEqual([...rootKey.bytes])
  })

  it('leaves the password wrap alone, so nothing is re-encrypted', async () => {
    // The point of rotating only the recovery wrap: the root key is untouched, so the
    // password still opens the account and not one event has to be re-sealed.
    const rootKey = createRootKey()
    const passwordWrap = await wrapRootKey(rootKey, await wrapKeyFor(OLD), 'password')

    await wrapRootKey(rootKey, await deriveRecoveryWrapKey(generateRecoveryPhrase()), 'recovery')

    const opened = await unwrapRootKey(passwordWrap, await wrapKeyFor(OLD))
    expect([...opened.bytes]).toEqual([...rootKey.bytes])
  })

  it('cannot be relabelled into the password slot', async () => {
    // The wrap's KIND is authenticated data, not a label beside the ciphertext. So an
    // attacker who can write to root_key_wraps cannot move the recovery row into the
    // password slot by flipping one column — the AAD stops matching and it fails to open.
    //
    // Worth pinning here because rotation is the moment that row is rewritten, and a
    // rotation that dropped the binding would look identical in every other test.
    const rootKey = createRootKey()
    const phrase = generateRecoveryPhrase()
    const recovery = await wrapRootKey(rootKey, await deriveRecoveryWrapKey(phrase), 'recovery')

    const relabelled = { ...recovery, kind: 'password' as const }
    await expect(unwrapRootKey(relabelled, await deriveRecoveryWrapKey(phrase))).rejects.toThrow()

    // Not vacuous: with the label left alone, the same key opens it.
    const opened = await unwrapRootKey(recovery, await deriveRecoveryWrapKey(phrase))
    expect([...opened.bytes]).toEqual([...rootKey.bytes])
  })
})
