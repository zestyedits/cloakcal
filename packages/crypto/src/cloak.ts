/**
 * Cloak — the client-side encryption boundary.
 *
 * SCOPE OF THIS VERSION (M1). This is real AEAD, not a placeholder: AES-256-GCM with
 * HKDF-derived per-field keys and additional authenticated data bound to the field's
 * identity. What it is NOT yet is multi-recipient — every field is encrypted to the
 * owner's root key. Access envelopes (wrapping a content key to another recipient's
 * device or contact key) arrive at M3. Nothing here needs to change when they do; the
 * envelope layer sits above the per-field key, which is why the key is derived rather
 * than hardcoded.
 *
 * WHY PER-FIELD KEYS. Field-level visibility is the product. Deriving a distinct key per
 * field means disclosing "title but not location" is a key-distribution problem rather
 * than a re-encryption problem: hand over the title key and the location stays sealed,
 * with no ciphertext rewritten and no content key revealed.
 *
 * WHY AAD. Without it, a valid (ciphertext, nonce) pair could be lifted from one field or
 * event and pasted into another, and it would decrypt cleanly — the server cannot detect
 * this because the server cannot read any of it. Binding subject type, subject id, field
 * name and key version into the AAD makes a transplanted ciphertext fail authentication.
 *
 * Uses WebCrypto only, so the same code runs in Node 24, the browser and a future native
 * webview. No third-party crypto dependency: reviewed primitives, no bespoke constructions.
 */

export const CLOAK_ALG = 'aes-256-gcm-v1' as const
export type CloakAlg = typeof CLOAK_ALG

export const CURRENT_KEY_VERSION = 1

/** 96 bits, the size AES-GCM is specified for. Never reuse one under the same key. */
const NONCE_BYTES = 12
const KEY_BYTES = 32

/**
 * Byte arrays crossing the WebCrypto boundary must be backed by a plain ArrayBuffer.
 * TypeScript 5.9 parameterises Uint8Array over its buffer, and `BufferSource` excludes
 * SharedArrayBuffer — pinning it here means a caller cannot hand us shared memory, which
 * would be a genuine hazard for key material.
 */
export type CloakBytes = Uint8Array<ArrayBuffer>

export type CloakSubjectType = 'event' | 'calendar' | 'workspace'

export interface CloakSubject {
  readonly type: CloakSubjectType
  readonly id: string
}

export interface CloakedPayload {
  readonly ciphertext: CloakBytes
  readonly nonce: CloakBytes
  readonly alg: CloakAlg
  readonly keyVersion: number
}

const utf8 = new TextEncoder()
const fromUtf8 = new TextDecoder()

export const subtle = (): SubtleCrypto => {
  const c = globalThis.crypto
  if (!c?.subtle) {
    throw new Error('WebCrypto unavailable. Cloak requires a secure context or Node >= 20.')
  }
  return c.subtle
}

/**
 * A user's root key. 32 random bytes, generated on device.
 *
 * In the full design this is wrapped three ways — password KEK, recovery phrase, and each
 * paired device (plan D7). Generation and wrapping land at M3; this type exists now so
 * call sites never pass a bare Uint8Array of unknown provenance.
 */
export interface RootKey {
  readonly bytes: CloakBytes
}

export function createRootKey(): RootKey {
  const bytes = new Uint8Array(KEY_BYTES)
  globalThis.crypto.getRandomValues(bytes)
  return { bytes }
}

/** Deterministic root key for tests and seed data. Never use outside test fixtures. */
export function rootKeyFromSeedBytes(seed: Uint8Array): RootKey {
  if (seed.length !== KEY_BYTES) {
    throw new Error(`Root key must be exactly ${KEY_BYTES} bytes, received ${seed.length}`)
  }
  return { bytes: new Uint8Array(seed) }
}

/**
 * Canonical, unambiguous encoding of a component list.
 *
 * Each component is written as a 4-byte big-endian length followed by its UTF-8 bytes,
 * after a fixed domain tag and a component count. Two different component lists can never
 * produce the same bytes.
 *
 * WHY NOT DELIMITER JOINING. The obvious `a|b|c` encoding is ambiguous the moment any
 * component can contain the delimiter — and custom field names (`custom:*`) are
 * user-supplied, so they can. Length prefixing removes the entire question rather than
 * requiring an argument about whether a particular collision is currently reachable.
 * Raised in M0 review round 2.
 */
export function encodeCanonical(domain: string, parts: readonly string[]): CloakBytes {
  const encoded = [utf8.encode(domain), ...parts.map((p) => utf8.encode(p))]
  const total = 1 + encoded.reduce((n, b) => n + 4 + b.length, 0)

  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  let offset = 0

  // Component count guards against a domain tag that could itself be split.
  out[offset] = encoded.length
  offset += 1

  for (const bytes of encoded) {
    view.setUint32(offset, bytes.length, false)
    offset += 4
    out.set(bytes, offset)
    offset += bytes.length
  }

  return out
}

/**
 * Additional authenticated data. Not secret — it is authenticated, not encrypted — but any
 * change to it makes decryption fail, which is exactly the anti-transplant property we
 * want: a sealed value cannot be moved to another field, event, subject type or key
 * version.
 */
function buildAad(subject: CloakSubject, fieldName: string, keyVersion: number): CloakBytes {
  return encodeCanonical('cloakcal.aad.v1', [
    subject.type,
    subject.id,
    fieldName,
    String(keyVersion),
  ])
}

/**
 * Per-field key = HKDF-SHA256(rootKey, salt = subject id, info = field label).
 *
 * The subject id as salt keeps two events with the same field name from sharing a key,
 * so a nonce collision in one event cannot weaken another.
 */
async function deriveFieldKey(
  rootKey: RootKey,
  subject: CloakSubject,
  fieldName: string,
  keyVersion: number,
): Promise<CryptoKey> {
  const s = subtle()
  const material = await s.importKey('raw', rootKey.bytes, 'HKDF', false, ['deriveKey'])

  return s.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      // Canonically encoded for the same reason as the AAD: a user-supplied field name
      // must not be able to collide with another field's derivation inputs.
      salt: encodeCanonical('cloakcal.salt.v1', [subject.type, subject.id]),
      info: encodeCanonical('cloakcal.field-key.v1', [fieldName, String(keyVersion)]),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable: the derived key cannot be read back out
    ['encrypt', 'decrypt'],
  )
}

export async function cloakField(
  rootKey: RootKey,
  subject: CloakSubject,
  fieldName: string,
  plaintext: string,
  keyVersion: number = CURRENT_KEY_VERSION,
): Promise<CloakedPayload> {
  if (fieldName.length === 0) throw new Error('fieldName is required')

  const key = await deriveFieldKey(rootKey, subject, fieldName, keyVersion)
  const nonce = new Uint8Array(NONCE_BYTES)
  globalThis.crypto.getRandomValues(nonce)

  const ciphertext = await subtle().encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: buildAad(subject, fieldName, keyVersion) },
    key,
    utf8.encode(plaintext),
  )

  return {
    ciphertext: new Uint8Array(ciphertext),
    nonce,
    alg: CLOAK_ALG,
    keyVersion,
  }
}

/**
 * Throws on any tampering, wrong key, or transplanted ciphertext. It deliberately does
 * not return null or an empty string: a decryption failure is a security event, and a
 * caller that silently renders "" would hide it.
 */
export async function uncloakField(
  rootKey: RootKey,
  subject: CloakSubject,
  fieldName: string,
  payload: CloakedPayload,
): Promise<string> {
  if (payload.alg !== CLOAK_ALG) {
    throw new Error(`Unsupported cloak algorithm "${payload.alg}"`)
  }
  if (payload.nonce.length !== NONCE_BYTES) {
    throw new Error(`Nonce must be ${NONCE_BYTES} bytes, received ${payload.nonce.length}`)
  }

  const key = await deriveFieldKey(rootKey, subject, fieldName, payload.keyVersion)

  let plaintext: ArrayBuffer
  try {
    plaintext = await subtle().decrypt(
      {
        name: 'AES-GCM',
        iv: payload.nonce,
        additionalData: buildAad(subject, fieldName, payload.keyVersion),
      },
      key,
      payload.ciphertext,
    )
  } catch {
    // WebCrypto reports every failure identically, on purpose. Do not attempt to
    // distinguish "wrong key" from "tampered" — that distinction is an oracle.
    throw new Error('Cloak decryption failed: wrong key, tampered data, or wrong field')
  }

  return fromUtf8.decode(plaintext)
}
