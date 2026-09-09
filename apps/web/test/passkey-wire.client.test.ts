import { describe, expect, it } from 'vitest'

import {
  fromAssertedCredential,
  fromBase64Url,
  fromCreatedCredential,
  toBase64Url,
  toCreationOptions,
  toRequestOptions,
} from '../src/lib/passkey-wire'

/**
 * The wire format, pinned because a mistake in it is SILENT.
 *
 * This is the bytea lesson in a different encoding. `pg-bytes.ts` records that a format
 * mismatch produces no error anywhere — a wrong parse yields bytes, the bytes yield a key,
 * the key fails to open a wrap, and a failed GCM tag is just a label that never opens. The
 * same is true here in both directions: a challenge decoded wrong is still a valid
 * ArrayBuffer, and the ceremony fails as "that was cancelled" with nothing naming the
 * cause. So the round trip gets vectors rather than trust.
 */
describe('base64url', () => {
  it('round-trips every byte value', () => {
    const all = new Uint8Array(256)
    for (let i = 0; i < 256; i += 1) all[i] = i
    expect([...fromBase64Url(toBase64Url(all))]).toEqual([...all])
  })

  /*
   * THE PADDING CASE, which is the one that actually breaks. Supabase strips `=`, and
   * `atob` throws on a length that is not a multiple of four — so a decoder that forgets to
   * re-pad fails on three input lengths out of four. Intermittently, which is worse than
   * always: it would work in development and fail for some fraction of real challenges.
   */
  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8])('re-pads a %i-byte value', (length) => {
    const bytes = new Uint8Array(length).fill(0xab)
    const encoded = toBase64Url(bytes)
    expect(encoded).not.toContain('=')
    expect([...fromBase64Url(encoded)]).toEqual([...bytes])
  })

  it('uses the url alphabet, never + or /', () => {
    // 0xfb 0xff encodes to "+/8" in standard base64, which is the pair that must differ.
    expect(toBase64Url(new Uint8Array([0xfb, 0xff]))).toBe('-_8')
    expect([...fromBase64Url('-_8')]).toEqual([0xfb, 0xff])
  })
})

describe('creation options', () => {
  const json = {
    challenge: toBase64Url(new Uint8Array([1, 2, 3])),
    rp: { id: 'cloakcal.com', name: 'CloakCal' },
    user: { id: toBase64Url(new Uint8Array([9, 9])), name: 'a@b.test', displayName: 'a@b.test' },
    pubKeyCredParams: [{ type: 'public-key' as const, alg: -7 }],
    excludeCredentials: [{ id: toBase64Url(new Uint8Array([4, 5])), type: 'public-key' as const }],
  }

  it('decodes the challenge, the user id and every excluded credential', () => {
    const options = toCreationOptions(json, {})
    expect([...new Uint8Array(options.challenge as ArrayBuffer)]).toEqual([1, 2, 3])
    expect([...new Uint8Array(options.user.id as ArrayBuffer)]).toEqual([9, 9])
    expect([...new Uint8Array(options.excludeCredentials![0]!.id as ArrayBuffer)]).toEqual([4, 5])
  })

  it('carries our extensions through', () => {
    const options = toCreationOptions(json, { prf: {} } as AuthenticationExtensionsClientInputs)
    expect(options.extensions).toEqual({ prf: {} })
  })

  /*
   * NOT A DEFAULT, A SECURITY DECISION. PRF output only exists after the authenticator
   * verifies a human, and ADR 0005 leans on that to argue an attacker at an unlocked laptop
   * cannot walk this route. A server that sent 'preferred' would quietly remove it, so the
   * server does not get a vote.
   */
  it('forces user verification even when the server asks for less', () => {
    const relaxed = { ...json, authenticatorSelection: { userVerification: 'preferred' as const } }
    expect(toCreationOptions(relaxed, {}).authenticatorSelection?.userVerification).toBe('required')
    expect(toRequestOptions({ challenge: json.challenge, userVerification: 'preferred' }, {}).userVerification).toBe('required')
  })
})

describe('credential responses', () => {
  const base = (response: unknown) =>
    ({ id: 'abc', rawId: new Uint8Array([7, 7]).buffer, type: 'public-key', response }) as unknown as PublicKeyCredential

  it('serialises a created credential without echoing extension results', () => {
    const wire = fromCreatedCredential(
      base({
        clientDataJSON: new Uint8Array([1]).buffer,
        attestationObject: new Uint8Array([2]).buffer,
        getTransports: () => ['internal'],
      }),
    )
    expect(wire.rawId).toBe(toBase64Url(new Uint8Array([7, 7])))
    expect(wire.response.transports).toEqual(['internal'])
    // The PRF result is ours. It says nothing Supabase can verify and must not travel.
    expect(wire.clientExtensionResults).toEqual({})
  })

  it('omits transports when the authenticator does not report them', () => {
    const wire = fromCreatedCredential(
      base({ clientDataJSON: new Uint8Array([1]).buffer, attestationObject: new Uint8Array([2]).buffer }),
    )
    expect('transports' in wire.response).toBe(false)
  })

  it('serialises an assertion, and omits a null user handle', () => {
    const wire = fromAssertedCredential(
      base({
        clientDataJSON: new Uint8Array([1]).buffer,
        authenticatorData: new Uint8Array([2]).buffer,
        signature: new Uint8Array([3]).buffer,
        userHandle: null,
      }),
    )
    expect('userHandle' in wire.response).toBe(false)
    expect(wire.clientExtensionResults).toEqual({})
  })
})
