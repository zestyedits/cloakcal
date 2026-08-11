/**
 * PostgREST speaks `bytea` as a hex string prefixed with a literal backslash-x.
 *
 * Getting this wrong is quiet rather than loud: send a plain hex string and Postgres stores
 * the ASCII of the hex digits, so the row is twice the expected size and decrypts to
 * nothing — with no error anywhere. The length CHECKs on root_key_wraps exist partly to
 * turn that specific mistake into a constraint violation.
 */

const PREFIX = '\\x'

export function toPgBytea(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return PREFIX + hex
}

export function fromPgBytea(value: string): Uint8Array<ArrayBuffer> {
  const hex = value.startsWith(PREFIX) ? value.slice(PREFIX.length) : value
  if (hex.length % 2 !== 0) throw new Error('bytea payload has an odd number of hex digits')

  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) throw new Error('bytea payload contains a non-hex character')
    out[i] = byte
  }
  return out
}
