import { describe, expect, it } from 'vitest'
import {
  CLOAK_ALG,
  cloakField,
  createRootKey,
  rootKeyFromSeedBytes,
  uncloakField,
  type CloakSubject,
} from './cloak.js'

/**
 * These tests are mostly about what must FAIL. Round-tripping proves the happy path; the
 * security property is that every other path fails closed, loudly, and indistinguishably.
 */

const EVENT: CloakSubject = { type: 'event', id: '11111111-1111-4111-8111-111111111111' }
const OTHER_EVENT: CloakSubject = { type: 'event', id: '22222222-2222-4222-8222-222222222222' }

const seedKey = (fill: number) => rootKeyFromSeedBytes(new Uint8Array(32).fill(fill))

describe('round trip', () => {
  it('recovers the plaintext', async () => {
    const key = createRootKey()
    const payload = await cloakField(key, EVENT, 'title', 'Legal Call')
    expect(await uncloakField(key, EVENT, 'title', payload)).toBe('Legal Call')
  })

  it('handles unicode and long values without corruption', async () => {
    const key = createRootKey()
    const value = '🔒 Café — 会議 — ' + 'x'.repeat(5000)
    const payload = await cloakField(key, EVENT, 'notes', value)
    expect(await uncloakField(key, EVENT, 'notes', payload)).toBe(value)
  })

  it('is deterministic across processes given the same root key', async () => {
    // Matters for the seed: fixtures must decrypt in a later test run.
    const payload = await cloakField(seedKey(7), EVENT, 'title', 'Team Standup')
    expect(await uncloakField(seedKey(7), EVENT, 'title', payload)).toBe('Team Standup')
  })

  it('never emits plaintext bytes in the ciphertext', async () => {
    const key = createRootKey()
    const payload = await cloakField(key, EVENT, 'title', 'Legal Call')
    const asText = Buffer.from(payload.ciphertext).toString('utf8')
    expect(asText).not.toContain('Legal Call')
    expect(payload.alg).toBe(CLOAK_ALG)
  })

  it('uses a fresh nonce every time, so identical plaintext yields different ciphertext', async () => {
    const key = seedKey(3)
    const a = await cloakField(key, EVENT, 'title', 'Gym')
    const b = await cloakField(key, EVENT, 'title', 'Gym')
    expect(Buffer.from(a.nonce).equals(Buffer.from(b.nonce))).toBe(false)
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false)
  })
})

describe('fails closed', () => {
  it('rejects the wrong root key', async () => {
    const payload = await cloakField(seedKey(1), EVENT, 'title', 'Legal Call')
    await expect(uncloakField(seedKey(2), EVENT, 'title', payload)).rejects.toThrow(
      /decryption failed/i,
    )
  })

  it('rejects a ciphertext transplanted to another field', async () => {
    // The attack AAD exists to stop: move the sealed "notes" blob into the "title" slot.
    const key = seedKey(1)
    const payload = await cloakField(key, EVENT, 'notes', 'Sensitive. Do not sync.')
    await expect(uncloakField(key, EVENT, 'title', payload)).rejects.toThrow(/decryption failed/i)
  })

  it('rejects a ciphertext transplanted to another event', async () => {
    const key = seedKey(1)
    const payload = await cloakField(key, EVENT, 'title', 'Legal Call')
    await expect(uncloakField(key, OTHER_EVENT, 'title', payload)).rejects.toThrow(
      /decryption failed/i,
    )
  })

  it('rejects a ciphertext transplanted to another subject type', async () => {
    const key = seedKey(1)
    const payload = await cloakField(key, EVENT, 'title', 'Legal Call')
    const asCalendar = { type: 'calendar', id: EVENT.id } as const
    await expect(uncloakField(key, asCalendar, 'title', payload)).rejects.toThrow(
      /decryption failed/i,
    )
  })

  it('rejects flipped ciphertext bits', async () => {
    const key = seedKey(1)
    const payload = await cloakField(key, EVENT, 'title', 'Legal Call')
    const tampered = new Uint8Array(payload.ciphertext)
    tampered[0] = tampered[0]! ^ 0xff
    await expect(
      uncloakField(key, EVENT, 'title', { ...payload, ciphertext: tampered }),
    ).rejects.toThrow(/decryption failed/i)
  })

  it('rejects a swapped nonce', async () => {
    const key = seedKey(1)
    const payload = await cloakField(key, EVENT, 'title', 'Legal Call')
    const other = await cloakField(key, EVENT, 'title', 'Gym')
    await expect(
      uncloakField(key, EVENT, 'title', { ...payload, nonce: other.nonce }),
    ).rejects.toThrow(/decryption failed/i)
  })

  it('rejects a mismatched key version', async () => {
    const key = seedKey(1)
    const payload = await cloakField(key, EVENT, 'title', 'Legal Call')
    await expect(
      uncloakField(key, EVENT, 'title', { ...payload, keyVersion: 2 }),
    ).rejects.toThrow(/decryption failed/i)
  })

  it('rejects an unknown algorithm rather than guessing', async () => {
    const key = seedKey(1)
    const payload = await cloakField(key, EVENT, 'title', 'Legal Call')
    await expect(
      // Simulates a legacy or downgraded row arriving from the database.
      uncloakField(key, EVENT, 'title', { ...payload, alg: 'plaintext-v0' as never }),
    ).rejects.toThrow(/Unsupported cloak algorithm/)
  })

  it('rejects a malformed nonce length', async () => {
    const key = seedKey(1)
    const payload = await cloakField(key, EVENT, 'title', 'Legal Call')
    await expect(
      uncloakField(key, EVENT, 'title', { ...payload, nonce: new Uint8Array(8) }),
    ).rejects.toThrow(/Nonce must be 12 bytes/)
  })

  it('gives the same error for wrong key and tampered data, so it is not an oracle', async () => {
    const payload = await cloakField(seedKey(1), EVENT, 'title', 'Legal Call')
    const tampered = new Uint8Array(payload.ciphertext)
    tampered[1] = tampered[1]! ^ 0x01

    const wrongKey = await uncloakField(seedKey(2), EVENT, 'title', payload).catch(
      (e: Error) => e.message,
    )
    const tamperedMsg = await uncloakField(seedKey(1), EVENT, 'title', {
      ...payload,
      ciphertext: tampered,
    }).catch((e: Error) => e.message)

    expect(wrongKey).toBe(tamperedMsg)
  })
})

describe('key material', () => {
  it('refuses a root key of the wrong size', () => {
    expect(() => rootKeyFromSeedBytes(new Uint8Array(16))).toThrow(/exactly 32 bytes/)
  })

  it('generates distinct random root keys', () => {
    const a = createRootKey()
    const b = createRootKey()
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(false)
    expect(a.bytes).toHaveLength(32)
  })

  it('requires a field name', async () => {
    await expect(cloakField(seedKey(1), EVENT, '', 'x')).rejects.toThrow(/fieldName is required/)
  })
})

/**
 * M0 review round 2: explicit proofs for nonce discipline and encoding unambiguity.
 */

describe('nonce discipline', () => {
  it('uses a 96-bit nonce, the size AES-GCM is specified for', async () => {
    const payload = await cloakField(seedKey(5), EVENT, 'title', 'x')
    expect(payload.nonce).toHaveLength(12)
  })

  it('never reuses a nonce for the same derived field key across updates', async () => {
    // Editing one field repeatedly is the realistic reuse path: same subject, same field,
    // therefore the SAME derived key. Nonce reuse under one key is catastrophic for
    // GCM — it leaks the XOR of plaintexts and enables forgery.
    const key = seedKey(5)
    const seen = new Set<string>()

    for (let i = 0; i < 1000; i += 1) {
      const payload = await cloakField(key, EVENT, 'title', `revision ${i}`)
      seen.add(Buffer.from(payload.nonce).toString('hex'))
    }

    expect(seen.size).toBe(1000)
  })

  it('draws nonces from the CSPRNG, not a counter', async () => {
    const key = seedKey(5)
    const a = await cloakField(key, EVENT, 'title', 'x')
    const b = await cloakField(key, EVENT, 'title', 'x')

    // A counter would differ in only the final byte(s). Random 96-bit values differ
    // across many positions; require at least 4 differing bytes out of 12.
    const differing = [...a.nonce].filter((byte, i) => byte !== b.nonce[i]).length
    expect(differing).toBeGreaterThanOrEqual(4)
  })
})

describe('canonical encoding is unambiguous', () => {
  it('does not let a field name containing the old delimiter collide', async () => {
    // Under `a|b|c` joining, a custom field name containing "|" could shift the component
    // boundaries. Length-prefixed encoding makes these provably distinct.
    const key = seedKey(9)
    const sealed = await cloakField(key, EVENT, 'custom:a|1', 'secret')

    await expect(uncloakField(key, EVENT, 'custom:a', sealed)).rejects.toThrow(/decryption failed/i)
    await expect(uncloakField(key, EVENT, 'custom:a|1|1', sealed)).rejects.toThrow(
      /decryption failed/i,
    )
    expect(await uncloakField(key, EVENT, 'custom:a|1', sealed)).toBe('secret')
  })

  it('keeps prefix-related field names distinct', async () => {
    const key = seedKey(9)
    const sealed = await cloakField(key, EVENT, 'custom:ab', 'secret')
    await expect(uncloakField(key, EVENT, 'custom:a', sealed)).rejects.toThrow(/decryption failed/i)
  })

  it('does not let a field name impersonate the subject id boundary', async () => {
    const key = seedKey(9)
    const sealed = await cloakField(key, EVENT, 'title', 'secret')
    const spoofed = { type: 'event', id: `${EVENT.id}|title` } as const
    await expect(uncloakField(key, spoofed, '', sealed)).rejects.toThrow()
  })

  it('survives field names with slashes, colons and unicode', async () => {
    const key = seedKey(9)
    for (const field of ['custom:a/field/b', 'custom:🔒', 'custom:v1/field/x', 'custom:|||']) {
      const sealed = await cloakField(key, EVENT, field, `value for ${field}`)
      expect(await uncloakField(key, EVENT, field, sealed)).toBe(`value for ${field}`)
    }
  })
})
