import { describe, expect, it } from 'vitest'
import { createRootKey, subtle, type RootKey } from './cloak.js'
import {
  CURRENT_KDF_PARAMS,
  WeakKdfParamsError,
  bytesToHex,
  deriveAuthSecret,
  deriveMasterSecret,
  deriveWrapKey,
  hexToBytes,
  normalizeAccountEmail,
  type KdfParams,
} from './kdf.js'
import { RootKeyUnwrapError, unwrapRootKey, wrapRootKey } from './wrap.js'
import {
  InvalidRecoveryPhraseError,
  deriveRecoveryWrapKey,
  generateRecoveryPhrase,
  isValidRecoveryPhrase,
  normalizeRecoveryPhrase,
} from './recovery.js'
import {
  createDeviceKeyPair,
  exportDevicePublicKey,
  unwrapRootKeyWithDevice,
  wrapRootKeyToDevice,
} from './device.js'

/**
 * The key lifecycle, tested at its failure modes rather than its happy path.
 *
 * A round trip passing proves almost nothing here — an implementation that returned the
 * root key unencrypted would also round-trip. What the tests below actually assert is that
 * the wrong key fails, the wrong *kind* of key fails, a weakened KDF is refused, and the
 * credential we hand to the server is useless against the wrap. Those are the properties
 * ADR 0002 claims, so those are the ones that must be mechanically checked.
 */

/**
 * The client-enforced floor, used everywhere the parameters are not themselves the subject.
 * Production values are 64 MiB / t=3; running those in every case would add minutes to the
 * suite while testing the same code path.
 */
const FAST: KdfParams = { algorithm: 'argon2id', memoryKiB: 19_456, iterations: 2, parallelism: 1 }

const EMAIL = 'keith@example.com'
const PASSWORD = 'correct horse battery staple'

describe('password derivation', () => {
  it('is deterministic for the same password and email', async () => {
    const a = await deriveMasterSecret(PASSWORD, EMAIL, FAST)
    const b = await deriveMasterSecret(PASSWORD, EMAIL, FAST)
    expect(bytesToHex(a.bytes)).toBe(bytesToHex(b.bytes))
  })

  it('separates accounts: the same password at a different email derives a different key', async () => {
    const a = await deriveMasterSecret(PASSWORD, EMAIL, FAST)
    const b = await deriveMasterSecret(PASSWORD, 'someone.else@example.com', FAST)
    expect(bytesToHex(a.bytes)).not.toBe(bytesToHex(b.bytes))
  })

  it('normalizes the email, so casing and stray whitespace cannot lock a user out', async () => {
    const a = await deriveMasterSecret(PASSWORD, EMAIL, FAST)
    const b = await deriveMasterSecret(PASSWORD, '  Keith@Example.COM ', FAST)
    expect(bytesToHex(a.bytes)).toBe(bytesToHex(b.bytes))
    expect(normalizeAccountEmail(' A@B.C ')).toBe('a@b.c')
  })

  it('produces an auth secret that fits bcrypt without truncation', async () => {
    const master = await deriveMasterSecret(PASSWORD, EMAIL, FAST)
    const authSecret = await deriveAuthSecret(master)

    // Supabase bcrypts what it receives, and bcrypt silently discards input past 72 bytes.
    // A longer encoding here would quietly shrink the credential's real entropy.
    expect(authSecret).toMatch(/^[0-9a-f]{64}$/u)
    expect(new TextEncoder().encode(authSecret).length).toBeLessThanOrEqual(72)
  })

  it('refuses KDF parameters weaker than the client floor', async () => {
    // Parameters arrive from the server so they can be raised over time. A server that
    // could also LOWER them could make every user's derivation cheap to brute-force.
    await expect(
      deriveMasterSecret(PASSWORD, EMAIL, { ...FAST, memoryKiB: 1024 }),
    ).rejects.toThrow(WeakKdfParamsError)
    await expect(deriveMasterSecret(PASSWORD, EMAIL, { ...FAST, iterations: 1 })).rejects.toThrow(
      WeakKdfParamsError,
    )
    await expect(
      deriveMasterSecret(PASSWORD, EMAIL, { ...FAST, algorithm: 'md5' as 'argon2id' }),
    ).rejects.toThrow(WeakKdfParamsError)
  })

  it('ships production parameters at or above the floor', () => {
    expect(CURRENT_KDF_PARAMS.memoryKiB).toBeGreaterThanOrEqual(FAST.memoryKiB)
    expect(CURRENT_KDF_PARAMS.iterations).toBeGreaterThanOrEqual(FAST.iterations)
  })
})

describe('the auth/wrap split — the property ADR 0002 depends on', () => {
  it('gives the server a credential that cannot open the wrap', async () => {
    // This is the whole reason the split exists. Supabase receives the auth secret. If an
    // attacker holding it — including CloakCal itself, or anyone who steals the database —
    // could reach the wrapping key, then "we cannot read your events" would be a promise
    // rather than a fact.
    const master = await deriveMasterSecret(PASSWORD, EMAIL, FAST)
    const authSecret = await deriveAuthSecret(master)
    const wrapKey = await deriveWrapKey(master)

    const rootKey = createRootKey()
    const wrapped = await wrapRootKey(rootKey, wrapKey, 'password')

    // Everything an attacker with the auth secret can construct from it.
    const fromAuthSecret = await subtle().importKey(
      'raw',
      hexToBytes(authSecret),
      { name: 'AES-GCM' },
      false,
      ['decrypt'],
    )

    await expect(unwrapRootKey(wrapped, fromAuthSecret)).rejects.toThrow(RootKeyUnwrapError)
  })

  it('round-trips the root key through the password wrap', async () => {
    const master = await deriveMasterSecret(PASSWORD, EMAIL, FAST)
    const wrapKey = await deriveWrapKey(master)
    const rootKey = createRootKey()

    const wrapped = await wrapRootKey(rootKey, wrapKey, 'password')
    const recovered = await unwrapRootKey(wrapped, wrapKey)

    expect(bytesToHex(recovered.bytes)).toBe(bytesToHex(rootKey.bytes))
  })

  it('fails on the wrong password rather than returning something plausible', async () => {
    const rootKey = createRootKey()
    const right = await deriveWrapKey(await deriveMasterSecret(PASSWORD, EMAIL, FAST))
    const wrong = await deriveWrapKey(await deriveMasterSecret('not the password', EMAIL, FAST))

    const wrapped = await wrapRootKey(rootKey, right, 'password')
    await expect(unwrapRootKey(wrapped, wrong)).rejects.toThrow(RootKeyUnwrapError)
  })

  it('never puts the root key on the wire in the clear', async () => {
    const rootKey = createRootKey()
    const wrapKey = await deriveWrapKey(await deriveMasterSecret(PASSWORD, EMAIL, FAST))
    const wrapped = await wrapRootKey(rootKey, wrapKey, 'password')

    // The transmitted bytes must not contain the key material anywhere inside them.
    expect(bytesToHex(wrapped.wrapped)).not.toContain(bytesToHex(rootKey.bytes))
    expect(bytesToHex(wrapped.nonce)).not.toContain(bytesToHex(rootKey.bytes))
  })
})

describe('wrap integrity', () => {
  const wrapKeyFor = async () => deriveWrapKey(await deriveMasterSecret(PASSWORD, EMAIL, FAST))

  it('rejects a tampered wrap', async () => {
    const wrapKey = await wrapKeyFor()
    const wrapped = await wrapRootKey(createRootKey(), wrapKey, 'password')

    const corrupted = new Uint8Array(wrapped.wrapped)
    corrupted.set([(corrupted.at(0) ?? 0) ^ 0xff], 0)

    await expect(unwrapRootKey({ ...wrapped, wrapped: corrupted }, wrapKey)).rejects.toThrow(
      RootKeyUnwrapError,
    )
  })

  it('rejects a wrap presented under the wrong kind', async () => {
    // Without the kind in the AAD, a device wrap could be filed in the password slot and
    // would open normally — so anyone able to write that row could unlock the account with
    // a key they already hold.
    const wrapKey = await wrapKeyFor()
    const wrapped = await wrapRootKey(createRootKey(), wrapKey, 'device')

    await expect(unwrapRootKey({ ...wrapped, kind: 'password' }, wrapKey)).rejects.toThrow(
      RootKeyUnwrapError,
    )
  })

  it('rejects an authenticated payload that is not 32 bytes', async () => {
    // Authenticated, so not an attacker: schema drift or a bug. Still fatal, because a
    // truncated "root key" derives real-looking field keys that decrypt nothing, and the
    // user would see every event fail to open with no explanation.
    const wrapKey = await wrapKeyFor()
    const nonce = new Uint8Array(12)
    globalThis.crypto.getRandomValues(nonce)

    const short = await subtle().encrypt(
      {
        name: 'AES-GCM',
        iv: nonce,
        // Must match wrapAad('password') exactly, or this would fail for the wrong reason.
        additionalData: (await import('./cloak.js')).encodeCanonical('cloakcal.wrap-aad.v1', [
          'password',
        ]),
      },
      await deriveWrapKeyEncryptable(),
      new Uint8Array(16),
    )

    await expect(
      unwrapRootKey(
        { kind: 'password', wrapped: new Uint8Array(short), nonce, alg: 'aes-256-gcm-v1' },
        await deriveWrapKeyEncryptable(),
      ),
    ).rejects.toThrow(/is 16 bytes, expected 32/u)
    expect(wrapKey).toBeDefined()
  })
})

/** deriveWrapKey grants encrypt+decrypt, so it can build the malformed fixture above. */
async function deriveWrapKeyEncryptable(): Promise<CryptoKey> {
  return deriveWrapKey(await deriveMasterSecret(PASSWORD, EMAIL, FAST))
}

describe('recovery phrase', () => {
  it('generates 24 valid words', () => {
    const phrase = generateRecoveryPhrase()
    expect(phrase.split(' ')).toHaveLength(24)
    expect(isValidRecoveryPhrase(phrase)).toBe(true)
  })

  it('generates a different phrase every time', () => {
    const seen = new Set(Array.from({ length: 20 }, () => generateRecoveryPhrase()))
    expect(seen.size).toBe(20)
  })

  it('accepts a phrase however a real person pasted it', async () => {
    const phrase = generateRecoveryPhrase()
    const mangled = `  ${phrase.split(' ').join('\n  ').toUpperCase()}  `

    expect(normalizeRecoveryPhrase(mangled)).toBe(phrase)
    expect(isValidRecoveryPhrase(mangled)).toBe(true)

    const rootKey = createRootKey()
    const wrapped = await wrapRootKey(rootKey, await deriveRecoveryWrapKey(phrase), 'recovery')
    const recovered = await unwrapRootKey(wrapped, await deriveRecoveryWrapKey(mangled))
    expect(bytesToHex(recovered.bytes)).toBe(bytesToHex(rootKey.bytes))
  })

  it('catches a single mistyped word before any cryptography runs', async () => {
    // This is why BIP-39 rather than an ad-hoc wordlist. Without the checksum the only
    // signal would be "unwrap failed", which a user cannot tell apart from "wrong phrase".
    const words = generateRecoveryPhrase().split(' ')
    words[7] = words[7] === 'abandon' ? 'ability' : 'abandon'

    await expect(deriveRecoveryWrapKey(words.join(' '))).rejects.toThrow(InvalidRecoveryPhraseError)
    await expect(deriveRecoveryWrapKey(words.join(' '))).rejects.toThrow(/checksum/u)
  })

  it('rejects a phrase of the wrong length with a countable reason', async () => {
    const short = generateRecoveryPhrase().split(' ').slice(0, 12).join(' ')
    await expect(deriveRecoveryWrapKey(short)).rejects.toThrow(/expected 24 words, received 12/u)
  })

  it('does not open with a different valid phrase', async () => {
    const wrapped = await wrapRootKey(
      createRootKey(),
      await deriveRecoveryWrapKey(generateRecoveryPhrase()),
      'recovery',
    )
    await expect(
      unwrapRootKey(wrapped, await deriveRecoveryWrapKey(generateRecoveryPhrase())),
    ).rejects.toThrow(RootKeyUnwrapError)
  })
})

describe('device pairing', () => {
  it('moves the root key to a new device without the server seeing it', async () => {
    const newDevice = await createDeviceKeyPair()
    const publicKey = await exportDevicePublicKey(newDevice)
    const rootKey = createRootKey()

    // Runs on the already-unlocked device. Only this result reaches the server.
    const wrapped = await wrapRootKeyToDevice(rootKey, publicKey)
    expect(bytesToHex(wrapped.wrapped)).not.toContain(bytesToHex(rootKey.bytes))

    const recovered = await unwrapRootKeyWithDevice(wrapped, newDevice)
    expect(bytesToHex(recovered.bytes)).toBe(bytesToHex(rootKey.bytes))
  })

  it('keeps the device private key non-extractable', async () => {
    const device = await createDeviceKeyPair()
    expect(device.privateKey.extractable).toBe(false)
    await expect(subtle().exportKey('raw', device.privateKey)).rejects.toThrow()
  })

  it('does not open for a device that was not the recipient', async () => {
    const intended = await createDeviceKeyPair()
    const attacker = await createDeviceKeyPair()

    const wrapped = await wrapRootKeyToDevice(createRootKey(), await exportDevicePublicKey(intended))
    await expect(unwrapRootKeyWithDevice(wrapped, attacker)).rejects.toThrow()
  })

  it('fails when the ephemeral public key is substituted', async () => {
    // Both public keys are bound into the HKDF info, so swapping one changes the derived
    // key rather than yielding a shared secret that still opens the wrap.
    const device = await createDeviceKeyPair()
    const wrapped = await wrapRootKeyToDevice(createRootKey(), await exportDevicePublicKey(device))
    const other = await createDeviceKeyPair()

    await expect(
      unwrapRootKeyWithDevice(
        { ...wrapped, ephemeralPublicKey: await exportDevicePublicKey(other) },
        device,
      ),
    ).rejects.toThrow()
  })

  it('produces a different wrap each time for the same device', async () => {
    // Ephemeral per wrap. Two identical wraps would mean a reused shared secret.
    const device = await createDeviceKeyPair()
    const publicKey = await exportDevicePublicKey(device)
    const rootKey = createRootKey()

    const a = await wrapRootKeyToDevice(rootKey, publicKey)
    const b = await wrapRootKeyToDevice(rootKey, publicKey)

    expect(bytesToHex(a.ephemeralPublicKey)).not.toBe(bytesToHex(b.ephemeralPublicKey))
    expect(bytesToHex(a.wrapped)).not.toBe(bytesToHex(b.wrapped))
  })
})

describe('hex helpers', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array(64)
    globalThis.crypto.getRandomValues(bytes)
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes)
  })

  it('rejects malformed hex loudly', () => {
    expect(() => hexToBytes('abc')).toThrow(/even length/u)
    expect(() => hexToBytes('zz')).toThrow(/non-hex/u)
  })
})

/** Present so the RootKey type is exercised at a value position, not just structurally. */
const _typeCheck: RootKey = createRootKey()
void _typeCheck
