import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { USER_A, USER_B, createTestDb, type TestDb } from './harness.js'

/**
 * 0023 — the `passkey` wrap kind (ADR 0005).
 *
 * The property under test that does not exist anywhere else in this table is PLURALITY.
 * Every other kind is one-per-user or one-per-device, and 0006's comments frame a second
 * row as a silent fork. A passkey is the deliberate exception: a laptop and a phone are two
 * credentials, and a user with one passkey and no phrase is one lost device from nothing.
 *
 * So the two tests that matter most here are opposites, and both are needed. Two
 * credentials must coexist, or the feature does not do the thing it exists for. The same
 * credential twice must not, because THAT is the fork — an older row still opening the key
 * under a PRF salt the user believes they replaced.
 *
 * Everything else is the shape boundary: the paired CHECKs, which stop a wrap that no
 * authenticator can ever open again from being stored as though it were fine.
 */

const wrapped = (byte: number) => new Uint8Array(48).fill(byte) as Uint8Array<ArrayBuffer>
const nonce = () => new Uint8Array(12).fill(7) as Uint8Array<ArrayBuffer>
const credentialId = (byte: number, length = 32) =>
  new Uint8Array(length).fill(byte) as Uint8Array<ArrayBuffer>
const prfSalt = (byte: number, length = 32) =>
  new Uint8Array(length).fill(byte) as Uint8Array<ArrayBuffer>
const KDF = JSON.stringify({
  algorithm: 'argon2id',
  memoryKiB: 19456,
  iterations: 2,
  parallelism: 1,
})

const INSERT = `insert into public.root_key_wraps
    (user_id, kind, kdf, device_id, ephemeral_public_key, credential_id, prf_salt,
     wrapped, nonce, alg)
  values ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, 'aes-256-gcm-v1')`

/** A passkey wrap: no kdf, no device, no ephemeral key — credential id and PRF salt only. */
const passkeyRow = (
  userId: string,
  cred: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  fill: number,
) => [userId, 'passkey', null, null, null, cred, salt, wrapped(fill), nonce()]

describe('passkey root key wraps', () => {
  let db: TestDb

  beforeAll(async () => {
    db = await createTestDb()
    await db.createUser(USER_A, 'a@example.com')
    await db.createUser(USER_B, 'b@example.com')
  })

  afterAll(async () => {
    await db.close()
  })

  it('accepts the new kind and reads the row back intact', async () => {
    await db.as(USER_A, INSERT, passkeyRow(USER_A, credentialId(0x11), prfSalt(0x22), 1))

    const { rows } = await db.as(
      USER_A,
      `select kind,
              octet_length(credential_id) as cred_len,
              octet_length(prf_salt)      as salt_len,
              octet_length(wrapped)       as wrap_len,
              get_byte(credential_id, 0)  as cred_first,
              get_byte(prf_salt, 31)      as salt_last,
              kdf is null                 as no_kdf
         from public.root_key_wraps
        where user_id = $1 and kind = 'passkey'`,
      [USER_A],
    )

    // The bytes come back byte-identical, not merely the right length. A bytea round trip
    // that silently re-encoded would produce a wrap key that opens nothing, and the failure
    // would look exactly like a wrong password — the quiet-mismatch class pg-bytes.ts
    // documents.
    expect(rows).toEqual([
      {
        kind: 'passkey',
        cred_len: 32,
        salt_len: 32,
        wrap_len: 48,
        cred_first: 0x11,
        salt_last: 0x22,
        no_kdf: true,
      },
    ])
  })

  it('keeps two passkeys for one user, which is the whole point of the kind', async () => {
    // The laptop is already in from the test above; this is the phone. If a
    // one-per-user index had been copied across from `password` out of habit, this is the
    // line that fails, and it fails before anyone ships a feature that cannot do its job.
    await db.as(USER_A, INSERT, passkeyRow(USER_A, credentialId(0x33), prfSalt(0x44), 2))

    const { rows } = await db.as(
      USER_A,
      `select count(*)::int as n from public.root_key_wraps
        where user_id = $1 and kind = 'passkey'`,
      [USER_A],
    )
    expect(rows[0]!['n']).toBe(2)
  })

  it('refuses a second wrap for a credential that already has one', async () => {
    // This IS the fork 0006 warns about, just at credential granularity: re-enrolling a
    // credential must replace its wrap, never sit beside it, or the old PRF salt keeps
    // opening the account after the user believes they rotated it.
    await expect(
      db.as(USER_A, INSERT, passkeyRow(USER_A, credentialId(0x11), prfSalt(0x55), 3)),
    ).rejects.toThrow(/root_key_wraps_one_per_credential/u)
  })

  it('lets a different user hold the same credential id', async () => {
    // Scoped to (user_id, credential_id), not credential_id alone. A global unique index
    // would make an INSERT an oracle for whether another account had enrolled a credential.
    await db.as(USER_B, INSERT, passkeyRow(USER_B, credentialId(0x11), prfSalt(0x66), 4))

    const { rows } = await db.as(
      USER_B,
      `select count(*)::int as n from public.root_key_wraps where user_id = $1`,
      [USER_B],
    )
    expect(rows[0]!['n']).toBe(1)
  })

  it('hides a passkey wrap from another user', async () => {
    // The policy is `for all` on user_id and was not touched by 0023, so a new kind
    // inherits row authorisation. Asserted rather than assumed: "the policy still applies"
    // is precisely the sort of thing a new column tempts a reader to stop checking.
    const { rows } = await db.as(
      USER_B,
      `select id from public.root_key_wraps where user_id = $1`,
      [USER_A],
    )
    expect(rows).toEqual([])
  })

  it('hides every passkey wrap from an unauthenticated caller', async () => {
    // asUnauthenticated, not asAnon: this is Supabase's `anon` ROLE with its own grants,
    // which is the thing an HTTP request with no session actually runs as.
    const { rows } = await db
      .asUnauthenticated(`select id from public.root_key_wraps where kind = 'passkey'`)
      .catch(() => ({ rows: [] as Record<string, unknown>[] }))
    expect(rows).toEqual([])
  })

  it('refuses a passkey wrap written on behalf of another user', async () => {
    await expect(
      db.as(USER_B, INSERT, passkeyRow(USER_A, credentialId(0x77), prfSalt(0x88), 5)),
    ).rejects.toThrow(/row-level security/iu)
  })

  describe('the paired columns', () => {
    const OTHER = '00000000-0000-4000-8000-0000000000d1'

    beforeAll(async () => {
      await db.createUser(OTHER, 'd1@example.com')
    })

    it('requires a credential id on a passkey wrap', async () => {
      await expect(
        db.as(OTHER, INSERT, [
          OTHER, 'passkey', null, null, null, null, prfSalt(0x01), wrapped(1), nonce(),
        ]),
      ).rejects.toThrow(/root_key_wraps_credential_pair/u)
    })

    it('requires a PRF salt on a passkey wrap', async () => {
      await expect(
        db.as(OTHER, INSERT, [
          OTHER, 'passkey', null, null, null, credentialId(0x01), null, wrapped(1), nonce(),
        ]),
      ).rejects.toThrow(/root_key_wraps_prf_salt_pair/u)
    })

    it('forbids a credential id on a password wrap', async () => {
      await expect(
        db.as(OTHER, INSERT, [
          OTHER, 'password', KDF, null, null, credentialId(0x01), null, wrapped(1), nonce(),
        ]),
      ).rejects.toThrow(/root_key_wraps_credential_pair/u)
    })

    it('forbids a PRF salt on a recovery wrap', async () => {
      await expect(
        db.as(OTHER, INSERT, [
          OTHER, 'recovery', null, null, null, null, prfSalt(0x01), wrapped(1), nonce(),
        ]),
      ).rejects.toThrow(/root_key_wraps_prf_salt_pair/u)
    })

    it('forbids KDF parameters on a passkey wrap', async () => {
      // A passkey derives through HKDF from the authenticator's PRF output; there is no
      // Argon2id step, so a kdf blob here would describe a derivation that never happened.
      await expect(
        db.as(OTHER, INSERT, [
          OTHER, 'passkey', KDF, null, null, credentialId(0x01), prfSalt(0x01), wrapped(1),
          nonce(),
        ]),
      ).rejects.toThrow(/root_key_wraps_kdf_pair/u)
    })

    it('rejects a credential id outside WebAuthn’s 16..1023 bytes', async () => {
      await expect(
        db.as(OTHER, INSERT, passkeyRow(OTHER, credentialId(0x01, 15), prfSalt(0x01), 1)),
      ).rejects.toThrow(/root_key_wraps_credential_id_length/u)

      await expect(
        db.as(OTHER, INSERT, passkeyRow(OTHER, credentialId(0x01, 1024), prfSalt(0x01), 1)),
      ).rejects.toThrow(/root_key_wraps_credential_id_length/u)
    })

    it('rejects a PRF salt that is not exactly 32 bytes', async () => {
      // "At least 32" would be the tempting spelling and would be wrong: a 16-byte salt
      // still derives a key, the wrap still opens, and nothing downstream ever notices.
      await expect(
        db.as(OTHER, INSERT, passkeyRow(OTHER, credentialId(0x01), prfSalt(0x01, 16), 1)),
      ).rejects.toThrow(/root_key_wraps_prf_salt_length/u)
    })

    it('still rejects a kind that is not one of the four', async () => {
      // Every paired column is null here, deliberately. A near-miss kind like 'passkeys'
      // fails `credential_pair` FIRST if it carries passkey columns, because the
      // biconditional reads "not the passkey kind, so these must be absent" — which is a
      // true rejection of the wrong thing and would leave the widened kind list unchecked.
      await expect(
        db.as(OTHER, INSERT, [
          OTHER, 'passkeys', null, null, null, null, null, wrapped(1), nonce(),
        ]),
      ).rejects.toThrow(/root_key_wraps_kind_known/u)
    })
  })

  /**
   * Widening a CHECK is drop-and-recreate, and the partial unique indexes sit on the same
   * table. Nothing in 0023 touches them, which is exactly why they are re-asserted here:
   * "I did not mean to change that" is not evidence.
   */
  describe('the singular kinds stayed singular', () => {
    const SOLO = '00000000-0000-4000-8000-0000000000d2'

    beforeAll(async () => {
      await db.createUser(SOLO, 'd2@example.com')
    })

    it('still allows exactly one password wrap per user', async () => {
      await db.as(SOLO, INSERT, [
        SOLO, 'password', KDF, null, null, null, null, wrapped(1), nonce(),
      ])
      await expect(
        db.as(SOLO, INSERT, [
          SOLO, 'password', KDF, null, null, null, null, wrapped(2), nonce(),
        ]),
      ).rejects.toThrow(/root_key_wraps_one_password/u)
    })

    it('still allows exactly one recovery wrap per user', async () => {
      await db.as(SOLO, INSERT, [
        SOLO, 'recovery', null, null, null, null, null, wrapped(3), nonce(),
      ])
      await expect(
        db.as(SOLO, INSERT, [
          SOLO, 'recovery', null, null, null, null, null, wrapped(4), nonce(),
        ]),
      ).rejects.toThrow(/root_key_wraps_one_recovery/u)
    })

    it('lets one user hold a password, a recovery and two passkeys at once', async () => {
      // The end state the feature actually ships: the phrase is not replaced by a passkey,
      // it steps back to being the backstop (ADR 0005). If these were mutually exclusive,
      // enrolling a passkey would be quietly destroying the last resort.
      await db.as(SOLO, INSERT, passkeyRow(SOLO, credentialId(0xa1), prfSalt(0xb1), 5))
      await db.as(SOLO, INSERT, passkeyRow(SOLO, credentialId(0xa2), prfSalt(0xb2), 6))

      const { rows } = await db.as(
        SOLO,
        `select kind, count(*)::int as n from public.root_key_wraps
          where user_id = $1 group by kind order by kind`,
        [SOLO],
      )
      expect(rows).toEqual([
        { kind: 'passkey', n: 2 },
        { kind: 'password', n: 1 },
        { kind: 'recovery', n: 1 },
      ])
    })
  })

  /**
   * ADR 0006 asserts its random Argon2id salt needs no migration because it rides inside
   * the existing `kdf` jsonb. That claim is only true while nothing constrains that blob's
   * shape, so pin it here rather than leaving it as a comment in 0023 that could go stale.
   */
  it('stores ADR 0006’s random salt inside the existing kdf blob, no column needed', async () => {
    const user = '00000000-0000-4000-8000-0000000000d3'
    await db.createUser(user, 'd3@example.com')

    const kdf = JSON.stringify({
      algorithm: 'argon2id',
      memoryKiB: 19456,
      iterations: 2,
      parallelism: 1,
      salt: 'ZGVhZGJlZWZkZWFkYmVlZg==',
      saltEmail: 'd3@example.com',
    })
    await db.as(user, INSERT, [user, 'password', kdf, null, null, null, null, wrapped(1), nonce()])

    const { rows } = await db.as(
      user,
      `select kdf ->> 'salt' as salt, kdf ->> 'saltEmail' as salt_email
         from public.root_key_wraps where user_id = $1 and kind = 'password'`,
      [user],
    )
    expect(rows[0]).toEqual({ salt: 'ZGVhZGJlZWZkZWFkYmVlZg==', salt_email: 'd3@example.com' })

    // And no constraint anywhere is inspecting that blob, which is what makes the
    // "no migration" claim hold for the next key it gains too.
    const constraints = await db.raw(
      `select conname from pg_constraint
        where conrelid = 'public.root_key_wraps'::regclass
          and pg_get_constraintdef(oid) like '%kdf%'`,
    )
    expect(constraints.rows.map((r) => r['conname'])).toEqual(['root_key_wraps_kdf_pair'])
  })
})
