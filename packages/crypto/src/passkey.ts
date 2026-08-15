import { encodeCanonical, subtle, type CloakBytes, type RootKey } from './cloak.js'
import { unwrapRootKey, wrapRootKey, type WrappedRootKey } from './wrap.js'

/**
 * The passkey wrap: a root key sealed under a secret the authenticator derives.
 *
 * WHY THIS EXISTS (ADR 0005). Re-wrapping the root key needs its raw bytes, and the key
 * kept in the browser after unlock is deliberately non-extractable, so every password
 * change has to re-derive from something the user supplies. Until now that was the password
 * they have forgotten or twenty-four words. A passkey is a third thing: the WebAuthn PRF
 * extension hands back a stable per-credential secret, and it hands it back only after the
 * authenticator has verified the human — a fingerprint, a face, or the device PIN.
 *
 * WHAT THAT BUYS, precisely. Nothing new is stored anywhere. The PRF output exists for the
 * duration of one assertion and is derived from a key that never leaves the authenticator,
 * so this improves recovery WITHOUT making the vault readable — which was the whole reason
 * the obvious shortcut was rejected. And because the assertion needs user verification at
 * the moment of use, someone sitting at an already-unlocked laptop still cannot rotate the
 * password: they would need the finger too.
 *
 * WHAT IT DOES NOT BUY. A passkey that syncs through iCloud Keychain or Google Password
 * Manager is only as available as that account. That is a real dependency on a vendor, and
 * it is exactly why the 24-word phrase is not being removed — the phrase is the route that
 * depends on nobody.
 *
 * This module deliberately knows NOTHING about WebAuthn. It takes bytes and returns a key.
 * `navigator.credentials` lives in the app layer, where the DOM does; keeping the boundary
 * here means the derivation is testable with fixed vectors rather than a mocked
 * authenticator.
 */

/**
 * PRF outputs are 32 bytes. Anything else did not come from the extension we asked for.
 *
 * Exported so the app layer validates against the OUTPUT length rather than reusing the
 * salt length, which happens to be the same number today and is a different fact.
 */
export const PRF_OUTPUT_BYTES = 32

/** The salt we hand the authenticator, and store beside the wrap. Not a secret. */
export const PRF_SALT_BYTES = 32

export class InvalidPrfOutputError extends Error {
  constructor(received: number) {
    super(
      `a passkey PRF output must be ${PRF_OUTPUT_BYTES} bytes, received ${received}. ` +
        'This usually means the authenticator did not run the PRF extension at all.',
    )
    this.name = 'InvalidPrfOutputError'
  }
}

/**
 * A fresh PRF salt for a newly registered credential.
 *
 * Per-credential and random so two passkeys on one account never derive the same wrap key.
 * It is stored in the clear next to the wrap and that is correct: it is an HKDF input, and
 * the secret in this construction is the authenticator's PRF key, which is unreachable.
 */
export function createPrfSalt(): CloakBytes {
  const salt = new Uint8Array(PRF_SALT_BYTES)
  globalThis.crypto.getRandomValues(salt)
  return salt
}

/**
 * Turn a PRF output into the AES key that wraps the root key.
 *
 * HKDF-Extract first, exactly as the ECDH path does, and for the same reason: a PRF output
 * is a uniform-looking secret rather than a uniform one, and HKDF's extract step is what
 * makes that difference stop mattering. Feeding it to a KDF's expand stage alone would be
 * assuming the property we want.
 *
 * The `info` label is domain-separated from the recovery and device labels through the same
 * canonical encoder, so a key derived here cannot collide with one derived there even if
 * the inputs somehow matched. The SALT parameter is the shared constant rather than the PRF
 * salt: the per-credential separation is already carried by the PRF output itself, which is
 * a different value for every credential because the authenticator mixed our salt into it.
 */
export async function derivePasskeyWrapKey(prfOutput: Uint8Array): Promise<CryptoKey> {
  if (prfOutput.length !== PRF_OUTPUT_BYTES) throw new InvalidPrfOutputError(prfOutput.length)

  const s = subtle()
  const material = await s.importKey(
    'raw',
    prfOutput as Uint8Array<ArrayBuffer>,
    'HKDF',
    false,
    ['deriveKey'],
  )

  return s.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encodeCanonical('cloakcal.wrap-salt.v1', []),
      info: encodeCanonical('cloakcal.hkdf.v1', ['cloakcal.passkey.v1']),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** Seal the root key to a passkey's PRF output. */
export async function wrapRootKeyToPasskey(
  rootKey: RootKey,
  prfOutput: Uint8Array,
): Promise<WrappedRootKey> {
  return wrapRootKey(rootKey, await derivePasskeyWrapKey(prfOutput), 'passkey')
}

/**
 * Open the root key with a passkey's PRF output.
 *
 * The wrap's `kind` is bound into the AES-GCM AAD, so a wrap made for a password or a
 * recovery phrase cannot be opened here even by an attacker who can write to the table and
 * relabel rows. That property is free — `wrapAad` is generic over the kind — and
 * `rewrap.test.ts` already pins it for the other kinds.
 */
export async function unwrapRootKeyWithPasskey(
  wrapped: WrappedRootKey,
  prfOutput: Uint8Array,
): Promise<RootKey> {
  return unwrapRootKey(wrapped, await derivePasskeyWrapKey(prfOutput))
}
