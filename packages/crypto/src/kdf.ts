import { argon2id } from 'hash-wasm'
import { encodeCanonical, subtle, type CloakBytes } from './cloak.js'

/**
 * Password key derivation — the bridge between an account password and the root key.
 *
 * THE PROBLEM THIS SOLVES. ADR 0002 originally said the password wrap is "Argon2id over
 * the account password". Taken literally that is unsafe the moment the same password is
 * also the credential Supabase Auth receives: the server would hold the exact input to the
 * KDF, so it could derive the wrapping key and open the wrap it supposedly cannot open.
 * "We cannot read your events" would become a policy promise rather than a property of the
 * mathematics, which is precisely what plan decision D7 refuses.
 *
 * THE SPLIT. One expensive derivation, two independent cheap outputs:
 *
 *     masterSecret = Argon2id(password, salt = canonical(email), 64 MiB / t=3 / p=1)
 *       ├── authSecret = HKDF(masterSecret, info = "auth")   → sent to Supabase as the password
 *       └── wrapKey    = HKDF(masterSecret, info = "wrap")   → never leaves the device
 *
 * HKDF is one-way and the two `info` labels are distinct, so an attacker holding the
 * authSecret — which includes CloakCal's own database, and anyone who steals it — learns
 * nothing about the wrapKey. Supabase then bcrypts the authSecret again server-side, so the
 * stored credential is a hash of a hash of an Argon2id output.
 *
 * WHY A DETERMINISTIC SALT. The salt must be reproducible on a device that has not talked
 * to the server yet, because deriving the authSecret is a *precondition* of logging in. A
 * random per-user salt would have to be fetched first, which turns "does this account
 * exist" into an unauthenticated oracle and adds a round trip to every unlock. The email is
 * unique per account and domain-tagged here, which is what defeats cross-service rainbow
 * tables. Honest cost: two people who choose the same password at the same email — which is
 * to say, the same account — derive the same secret. That is not a distinct user, so it is
 * not a distinct exposure. This is the same trade Bitwarden and 1Password make.
 */

export interface KdfParams {
  readonly algorithm: 'argon2id'
  readonly memoryKiB: number
  readonly iterations: number
  readonly parallelism: number
}

/**
 * OWASP's Argon2id floor is m=19 MiB, t=2, p=1. These sit comfortably above it while
 * staying under a second on a mid-range phone, which matters because this runs on every
 * unlock, not just at signup.
 */
export const CURRENT_KDF_PARAMS: KdfParams = Object.freeze({
  algorithm: 'argon2id',
  memoryKiB: 65_536,
  iterations: 3,
  parallelism: 1,
})

/**
 * Params travel with the wrap so they can be raised later without invalidating old wraps.
 * That means they arrive FROM THE SERVER, and a server that can lower them can force a
 * cheap derivation — a downgrade attack that costs the attacker nothing. The client
 * therefore enforces its own floor and refuses anything weaker, so stored params can only
 * ever be used to make the derivation more expensive.
 */
const KDF_FLOOR = Object.freeze({ memoryKiB: 19_456, iterations: 2, parallelism: 1 })

export class WeakKdfParamsError extends Error {
  constructor(detail: string) {
    super(
      `Refusing to derive a key with weakened KDF parameters (${detail}). Parameters are ` +
        'server-supplied and may only ever be strengthened, never lowered.',
    )
    this.name = 'WeakKdfParamsError'
  }
}

export function assertKdfParams(params: KdfParams): void {
  if (params.algorithm !== 'argon2id') {
    throw new WeakKdfParamsError(`unsupported algorithm "${String(params.algorithm)}"`)
  }
  if (params.memoryKiB < KDF_FLOOR.memoryKiB) {
    throw new WeakKdfParamsError(`memory ${params.memoryKiB} KiB < ${KDF_FLOOR.memoryKiB} KiB`)
  }
  if (params.iterations < KDF_FLOOR.iterations) {
    throw new WeakKdfParamsError(`iterations ${params.iterations} < ${KDF_FLOOR.iterations}`)
  }
  if (params.parallelism < KDF_FLOOR.parallelism) {
    throw new WeakKdfParamsError(`parallelism ${params.parallelism} < ${KDF_FLOOR.parallelism}`)
  }
}

/**
 * Case and surrounding whitespace must not change the derived key, or a user who types
 * "Keith@Example.com " once and "keith@example.com" the next time is locked out of their
 * own data with no diagnosable cause.
 */
export const normalizeAccountEmail = (email: string): string => email.trim().toLowerCase()

/** Opaque holder so a raw master secret is never passed around as a bare byte array. */
export interface MasterSecret {
  readonly bytes: CloakBytes
}

export async function deriveMasterSecret(
  password: string,
  email: string,
  params: KdfParams = CURRENT_KDF_PARAMS,
): Promise<MasterSecret> {
  if (password.length === 0) throw new Error('password is required')
  assertKdfParams(params)

  const hex = await argon2id({
    password,
    salt: encodeCanonical('cloakcal.kdf-salt.v1', [normalizeAccountEmail(email)]),
    memorySize: params.memoryKiB,
    iterations: params.iterations,
    parallelism: params.parallelism,
    hashLength: 32,
    outputType: 'hex',
  })

  return { bytes: hexToBytes(hex) }
}

/**
 * The credential handed to Supabase Auth. Hex rather than raw bytes because it travels as
 * a password string, and 64 hex characters stays under bcrypt's 72-byte input limit — a
 * longer encoding would be silently truncated, quietly shrinking the credential.
 */
export async function deriveAuthSecret(master: MasterSecret): Promise<string> {
  const bits = await deriveBitsFrom(master, 'cloakcal.auth.v1', 256)
  return bytesToHex(new Uint8Array(bits))
}

/**
 * The AES-GCM key that wraps the root key. Non-extractable: once derived, the raw bytes
 * cannot be read back out of JavaScript, so a later bug cannot serialize it by accident.
 */
export async function deriveWrapKey(master: MasterSecret): Promise<CryptoKey> {
  const s = subtle()
  const material = await s.importKey('raw', master.bytes, 'HKDF', false, ['deriveKey'])

  return s.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encodeCanonical('cloakcal.wrap-salt.v1', []),
      info: encodeCanonical('cloakcal.hkdf.v1', ['cloakcal.wrap.v1']),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function deriveBitsFrom(
  master: MasterSecret,
  label: string,
  length: number,
): Promise<ArrayBuffer> {
  const s = subtle()
  const material = await s.importKey('raw', master.bytes, 'HKDF', false, ['deriveBits'])

  return s.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encodeCanonical('cloakcal.wrap-salt.v1', []),
      info: encodeCanonical('cloakcal.hkdf.v1', [label]),
    },
    material,
    length,
  )
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

export function hexToBytes(hex: string): CloakBytes {
  if (hex.length % 2 !== 0) throw new Error('hex string must have an even length')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) throw new Error('hex string contains a non-hex character')
    out[i] = byte
  }
  return out
}
