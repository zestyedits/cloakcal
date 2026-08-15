import { describe, expect, it } from 'vitest'
import { createRootKey } from './cloak.js'
import { unwrapRootKey, wrapRootKey, RootKeyUnwrapError } from './wrap.js'
import { deriveRecoveryWrapKey, generateRecoveryPhrase } from './recovery.js'
import {
  createPrfSalt,
  derivePasskeyWrapKey,
  InvalidPrfOutputError,
  PRF_SALT_BYTES,
  unwrapRootKeyWithPasskey,
  wrapRootKeyToPasskey,
} from './passkey.js'

/**
 * The passkey wrap (ADR 0005).
 *
 * These use fixed byte arrays as PRF outputs rather than a mocked authenticator, which is
 * the reason `passkey.ts` knows nothing about WebAuthn: the derivation is the part with
 * security consequences, and it is worth testing without a DOM in the way.
 */

const prf = (fill: number): Uint8Array => new Uint8Array(32).fill(fill)

describe('derivePasskeyWrapKey', () => {
  it('is deterministic, so the same passkey always opens its own wrap', async () => {
    // The entire feature rests on this. An authenticator returns the same PRF output for
    // the same credential and salt every time; if the derivation on top were not stable,
    // a wrap would open once and never again.
    const rootKey = createRootKey()
    const wrapped = await wrapRootKeyToPasskey(rootKey, prf(7))
    const opened = await unwrapRootKeyWithPasskey(wrapped, prf(7))
    expect([...opened.bytes]).toEqual([...rootKey.bytes])
  })

  it('gives a different key for a different PRF output', async () => {
    const rootKey = createRootKey()
    const wrapped = await wrapRootKeyToPasskey(rootKey, prf(7))
    await expect(unwrapRootKeyWithPasskey(wrapped, prf(8))).rejects.toThrow(RootKeyUnwrapError)
  })

  it('refuses an output that is not 32 bytes, rather than deriving from whatever it got', async () => {
    // The failure this catches is an authenticator that ignored the PRF extension. The
    // browser then hands back undefined or an empty result, and silently deriving a key
    // from a short or absent value would produce a wrap nothing can ever open.
    await expect(derivePasskeyWrapKey(new Uint8Array(0))).rejects.toThrow(InvalidPrfOutputError)
    await expect(derivePasskeyWrapKey(new Uint8Array(16))).rejects.toThrow(InvalidPrfOutputError)
    await expect(derivePasskeyWrapKey(new Uint8Array(64))).rejects.toThrow(InvalidPrfOutputError)
  })

  it('produces a non-extractable AES-GCM key', async () => {
    const key = await derivePasskeyWrapKey(prf(1))
    expect(key.extractable).toBe(false)
    expect(key.algorithm.name).toBe('AES-GCM')
    expect(key.usages.toSorted()).toEqual(['decrypt', 'encrypt'])
  })
})

describe('domain separation', () => {
  /**
   * The kind is bound into the AES-GCM AAD, so a passkey wrap relabelled as a password
   * wrap will not open even by someone who can write to the table. Free, because `wrapAad`
   * is generic over the kind — this asserts the freebie actually covers the new kind.
   */
  it('will not open a passkey wrap that has been relabelled', async () => {
    const rootKey = createRootKey()
    const key = await derivePasskeyWrapKey(prf(3))
    const wrapped = await wrapRootKeyToPasskey(rootKey, prf(3))

    const relabelled = { ...wrapped, kind: 'password' as const }
    await expect(unwrapRootKey(relabelled, key)).rejects.toThrow(RootKeyUnwrapError)
  })

  it('will not open a RECOVERY wrap with a passkey-derived key, or the reverse', async () => {
    // Different `info` labels, so even identical input bytes cannot produce the same key.
    const rootKey = createRootKey()
    // A real generated phrase, not a hand-written one: BIP-39 carries a checksum, and a
    // made-up 24 words is rejected before it ever reaches the derivation. (Which is the
    // library doing its job, and is how the first draft of this test failed.)
    const recoveryKey = await deriveRecoveryWrapKey(generateRecoveryPhrase())
    const recoveryWrap = await wrapRootKey(rootKey, recoveryKey, 'recovery')
    const passkeyWrap = await wrapRootKeyToPasskey(rootKey, prf(4))

    await expect(unwrapRootKeyWithPasskey(recoveryWrap, prf(4))).rejects.toThrow()
    await expect(unwrapRootKey(passkeyWrap, recoveryKey)).rejects.toThrow(RootKeyUnwrapError)
  })
})

describe('createPrfSalt', () => {
  it('is 32 random bytes, so two credentials never share a derivation', () => {
    const a = createPrfSalt()
    const b = createPrfSalt()
    expect(a.length).toBe(PRF_SALT_BYTES)
    expect([...a]).not.toEqual([...b])
    // Not all one value — a fill() bug would pass a length check and nothing else.
    expect(new Set(a).size).toBeGreaterThan(1)
  })
})

describe('the shape the feature actually needs', () => {
  /**
   * Two passkeys, one account: a laptop and a phone. Each has its own PRF output, so each
   * gets its own wrap of the SAME root key — which is what makes losing one device
   * survivable and is why the migration's unique index is per credential rather than per
   * user.
   */
  it('lets two different passkeys each open the same root key', async () => {
    const rootKey = createRootKey()
    const laptop = await wrapRootKeyToPasskey(rootKey, prf(11))
    const phone = await wrapRootKeyToPasskey(rootKey, prf(22))

    const fromLaptop = await unwrapRootKeyWithPasskey(laptop, prf(11))
    const fromPhone = await unwrapRootKeyWithPasskey(phone, prf(22))

    expect([...fromLaptop.bytes]).toEqual([...rootKey.bytes])
    expect([...fromPhone.bytes]).toEqual([...rootKey.bytes])
    // And neither opens the other's wrap.
    await expect(unwrapRootKeyWithPasskey(laptop, prf(22))).rejects.toThrow(RootKeyUnwrapError)
  })

  it('uses a fresh nonce per wrap, so two wraps of one key are not identical', async () => {
    const rootKey = createRootKey()
    const first = await wrapRootKeyToPasskey(rootKey, prf(5))
    const second = await wrapRootKeyToPasskey(rootKey, prf(5))
    expect([...first.nonce]).not.toEqual([...second.nonce])
    expect([...first.wrapped]).not.toEqual([...second.wrapped])
  })
})
