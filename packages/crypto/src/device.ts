import { encodeCanonical, subtle, type CloakBytes, type RootKey } from './cloak.js'
import { bytesToHex } from './kdf.js'
import { unwrapRootKey, wrapRootKey, type WrappedRootKey } from './wrap.js'

/**
 * Trusted-device pairing — the third wrap (D7).
 *
 * A new device generates a keypair whose private half never leaves it. An already-unlocked
 * device wraps the root key to that public key and hands the result to the server, which
 * stores bytes it cannot open. The new device unwraps locally. At no point does CloakCal
 * hold a key that opens anything.
 *
 * CURVE — A DOCUMENTED DIVERGENCE FROM ADR 0002. That ADR specifies X25519. This uses
 * ECDH P-256 instead. X25519 reached WebCrypto in Chrome 137, Firefox 132 and Safari 18.4;
 * P-256 has been universal for a decade and works in every mobile webview we target, which
 * matters because pairing is the recovery path a user reaches for when their other options
 * have already failed. Falling back at that moment is the worst possible time to discover a
 * browser gap. Both are ~128-bit security. The ADR is amended rather than quietly ignored.
 *
 * CONSTRUCTION — ECIES, not bare ECDH. An ephemeral keypair per wrap, HKDF over the shared
 * secret, then the ordinary AES-GCM root-key wrap. Both public keys are bound into the HKDF
 * `info`, which is what stops a shared secret from being valid against a substituted
 * recipient: an attacker who swaps in their own public key produces a different derived
 * key, so the wrap simply fails rather than opening for the wrong device.
 */

const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const

export interface DeviceKeyPair {
  /** Non-extractable. The whole point: this cannot be read out, only used. */
  readonly privateKey: CryptoKey
  readonly publicKey: CryptoKey
}

export interface DeviceWrappedRootKey extends WrappedRootKey {
  readonly kind: 'device'
  /** The sender's one-time public key. Public by design; needed to rederive the secret. */
  readonly ephemeralPublicKey: CloakBytes
}

export async function createDeviceKeyPair(): Promise<DeviceKeyPair> {
  const pair = await subtle().generateKey(CURVE, false, ['deriveKey', 'deriveBits'])
  return { privateKey: pair.privateKey, publicKey: pair.publicKey }
}

export async function exportDevicePublicKey(pair: DeviceKeyPair): Promise<CloakBytes> {
  return new Uint8Array(await subtle().exportKey('raw', pair.publicKey))
}

async function importPublicKey(bytes: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey('raw', bytes as Uint8Array<ArrayBuffer>, CURVE, true, [])
}

/**
 * Derived on both sides. `senderPublic` and `recipientPublic` go into `info` in a fixed
 * order — sender first, always — so the two devices agree without needing to negotiate.
 */
async function deriveSharedWrapKey(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  senderPublic: Uint8Array,
  recipientPublic: Uint8Array,
): Promise<CryptoKey> {
  const s = subtle()
  const shared = await s.deriveBits({ name: 'ECDH', public: peerPublicKey }, privateKey, 256)
  const material = await s.importKey('raw', new Uint8Array(shared), 'HKDF', false, ['deriveKey'])

  return s.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encodeCanonical('cloakcal.wrap-salt.v1', []),
      info: encodeCanonical('cloakcal.hkdf.v1', [
        'cloakcal.device.v1',
        bytesToHex(senderPublic),
        bytesToHex(recipientPublic),
      ]),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** Run on the already-unlocked device that is approving the pairing. */
export async function wrapRootKeyToDevice(
  rootKey: RootKey,
  recipientPublicKeyBytes: Uint8Array,
): Promise<DeviceWrappedRootKey> {
  const ephemeral = await subtle().generateKey(CURVE, true, ['deriveBits'])
  const ephemeralPublicKey = new Uint8Array(await subtle().exportKey('raw', ephemeral.publicKey))
  const recipientPublicKey = await importPublicKey(recipientPublicKeyBytes)

  const wrapKey = await deriveSharedWrapKey(
    ephemeral.privateKey,
    recipientPublicKey,
    ephemeralPublicKey,
    recipientPublicKeyBytes,
  )

  const wrapped = await wrapRootKey(rootKey, wrapKey, 'device')
  return { ...wrapped, kind: 'device', ephemeralPublicKey }
}

/** Run on the new device, with the private key it generated and never shared. */
export async function unwrapRootKeyWithDevice(
  wrapped: DeviceWrappedRootKey,
  pair: DeviceKeyPair,
): Promise<RootKey> {
  const recipientPublicKeyBytes = await exportDevicePublicKey(pair)
  const ephemeralPublicKey = await importPublicKey(wrapped.ephemeralPublicKey)

  const wrapKey = await deriveSharedWrapKey(
    pair.privateKey,
    ephemeralPublicKey,
    wrapped.ephemeralPublicKey,
    recipientPublicKeyBytes,
  )

  return unwrapRootKey(wrapped, wrapKey)
}
