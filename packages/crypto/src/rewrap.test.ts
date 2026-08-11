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
