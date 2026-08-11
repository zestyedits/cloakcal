import { CLOAK_ALG, encodeCanonical, subtle, type CloakAlg, type CloakBytes, type RootKey } from './cloak.js'

/**
 * Wrapping the User Root Key.
 *
 * The URK is 32 bytes that must survive a reload, reach a second device, and be
 * recoverable after a forgotten password — without CloakCal ever holding a copy it can
 * open. Every one of those needs is the same operation with a different wrapping key, so
 * there is one wrap primitive here and three key sources (kdf.ts, recovery.ts, device.ts).
 *
 * WHY THE KIND IS IN THE AAD. Without it, a wrap produced for one purpose is a valid input
 * to another. A stolen device wrap could be filed as the password wrap, and any attacker
 * able to write a row would then unlock the account with a key they already hold. Binding
 * the kind means each wrap only opens in the slot it was made for; the check is free and
 * the failure mode it prevents is total.
 *
 * WHY NOT AES-KW. `wrapKey`/`unwrapKey` with AES-KW is the textbook answer, but it produces
 * an opaque `CryptoKey` on the way out and carries no associated data. We need the URK as
 * bytes (it is HKDF input material, not an AES key), and we need the AAD binding above, so
 * AES-GCM over the raw bytes is both simpler and stronger here.
 */

export type WrapKind = 'password' | 'recovery' | 'device'

export interface WrappedRootKey {
  readonly kind: WrapKind
  readonly wrapped: CloakBytes
  readonly nonce: CloakBytes
  readonly alg: CloakAlg
}

const NONCE_BYTES = 12
const ROOT_KEY_BYTES = 32

const wrapAad = (kind: WrapKind): CloakBytes =>
  encodeCanonical('cloakcal.wrap-aad.v1', [kind])

export class RootKeyUnwrapError extends Error {
  constructor(kind: WrapKind) {
    super(
      `Could not unwrap the root key from the ${kind} wrap: wrong key, tampered data, or a ` +
        'wrap made for a different purpose.',
    )
    this.name = 'RootKeyUnwrapError'
  }
}

export async function wrapRootKey(
  rootKey: RootKey,
  wrapKey: CryptoKey,
  kind: WrapKind,
): Promise<WrappedRootKey> {
  const nonce = new Uint8Array(NONCE_BYTES)
  globalThis.crypto.getRandomValues(nonce)

  const wrapped = await subtle().encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: wrapAad(kind) },
    wrapKey,
    rootKey.bytes,
  )

  return { kind, wrapped: new Uint8Array(wrapped), nonce, alg: CLOAK_ALG }
}

export async function unwrapRootKey(
  wrapped: WrappedRootKey,
  wrapKey: CryptoKey,
): Promise<RootKey> {
  if (wrapped.alg !== CLOAK_ALG) {
    throw new Error(`Unsupported wrap algorithm "${wrapped.alg}"`)
  }

  let bytes: ArrayBuffer
  try {
    bytes = await subtle().decrypt(
      { name: 'AES-GCM', iv: wrapped.nonce, additionalData: wrapAad(wrapped.kind) },
      wrapKey,
      wrapped.wrapped,
    )
  } catch {
    // As in uncloakField: WebCrypto reports every failure identically and we keep it that
    // way. Distinguishing "wrong password" from "tampered wrap" would be an oracle.
    throw new RootKeyUnwrapError(wrapped.kind)
  }

  if (bytes.byteLength !== ROOT_KEY_BYTES) {
    // Authenticated, so this is not an attacker — it is a bug or a schema drift. Still
    // fatal: a short "root key" would derive real-looking field keys that decrypt nothing.
    throw new Error(`Unwrapped root key is ${bytes.byteLength} bytes, expected ${ROOT_KEY_BYTES}`)
  }

  return { bytes: new Uint8Array(bytes) }
}
