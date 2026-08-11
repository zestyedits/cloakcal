import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { USER_A, USER_B, createTestDb, type TestDb } from './harness.js'

/**
 * root_key_wraps — the table that must never give anything away.
 *
 * Every row here is the User Root Key sealed under a key the server does not have. The
 * cryptography that makes that true is tested in packages/crypto; what is tested HERE is
 * the boundary around it: that one user cannot read another's wrap, that an anonymous
 * caller cannot read any, and that the shape constraints reject rows which would otherwise
 * put the account into a state the unlock flow cannot reason about.
 *
 * The uniqueness cases matter more than they look. Two password wraps for one user is not
 * a duplicate row, it is a silent fork: changing the password would leave the older wrap in
 * place, still opening the account with a password the user believes they retired.
 */

const wrapped = (byte: number) =>
  new Uint8Array(48).fill(byte) as Uint8Array<ArrayBuffer>
const nonce = () => new Uint8Array(12).fill(7) as Uint8Array<ArrayBuffer>
const KDF = JSON.stringify({ algorithm: 'argon2id', memoryKiB: 65536, iterations: 3, parallelism: 1 })

const INSERT = `insert into public.root_key_wraps
    (user_id, kind, kdf, device_id, ephemeral_public_key, wrapped, nonce, alg)
  values ($1, $2, $3::jsonb, $4, $5, $6, $7, 'aes-256-gcm-v1')`

describe('root_key_wraps', () => {
  let db: TestDb

  beforeAll(async () => {
    db = await createTestDb()
    await db.createUser(USER_A, 'a@example.com')
    await db.createUser(USER_B, 'b@example.com')
  })

  afterAll(async () => {
    await db.close()
  })

  it('lets a user store and read back their own password wrap', async () => {
    await db.as(USER_A, INSERT, [USER_A, 'password', KDF, null, null, wrapped(1), nonce()])

    const { rows } = await db.as(
      USER_A,
      `select kind, octet_length(wrapped) as len from public.root_key_wraps where user_id = $1`,
      [USER_A],
    )
    expect(rows).toEqual([{ kind: 'password', len: 48 }])
  })

  it('hides one user’s wrap from another', async () => {
    const { rows } = await db.as(USER_B, 'select * from public.root_key_wraps')
    expect(rows).toEqual([])
  })

  it('hides every wrap from an anonymous caller', async () => {
    const { rows } = await db.asAnon('select * from public.root_key_wraps')
    expect(rows).toEqual([])
  })

  it('refuses a wrap written on behalf of another user', async () => {
    // WITH CHECK raises rather than silently dropping the row, which is what we want:
    // an unnoticed no-op here would look like a successful key backup.
    await expect(
      db.as(USER_B, INSERT, [USER_A, 'password', KDF, null, null, wrapped(2), nonce()]),
    ).rejects.toThrow(/row-level security/iu)
  })

  it('allows only one password wrap per user', async () => {
    await expect(
      db.as(USER_A, INSERT, [USER_A, 'password', KDF, null, null, wrapped(3), nonce()]),
    ).rejects.toThrow(/root_key_wraps_one_password/u)
  })

  it('allows only one recovery wrap per user', async () => {
    await db.as(USER_A, INSERT, [USER_A, 'recovery', null, null, null, wrapped(4), nonce()])
    await expect(
      db.as(USER_A, INSERT, [USER_A, 'recovery', null, null, null, wrapped(5), nonce()]),
    ).rejects.toThrow(/root_key_wraps_one_recovery/u)
  })

  it('requires KDF parameters on a password wrap and forbids them elsewhere', async () => {
    await expect(
      db.as(USER_B, INSERT, [USER_B, 'password', null, null, null, wrapped(6), nonce()]),
    ).rejects.toThrow(/root_key_wraps_kdf_pair/u)

    await expect(
      db.as(USER_B, INSERT, [USER_B, 'recovery', KDF, null, null, wrapped(7), nonce()]),
    ).rejects.toThrow(/root_key_wraps_kdf_pair/u)
  })

  it('requires a device and an ephemeral key on a device wrap', async () => {
    await expect(
      db.as(USER_B, INSERT, [USER_B, 'device', null, null, null, wrapped(8), nonce()]),
    ).rejects.toThrow(/root_key_wraps_device_pair/u)
  })

  it('stores a device wrap once the device exists', async () => {
    const publicKey = new Uint8Array(65).fill(4) as Uint8Array<ArrayBuffer>
    const { rows } = await db.as(
      USER_B,
      `insert into public.devices (user_id, label, public_key) values ($1, 'Phone', $2) returning id`,
      [USER_B, publicKey],
    )
    const deviceId = (rows[0] as { id: string }).id

    await db.as(USER_B, INSERT, [USER_B, 'device', null, deviceId, publicKey, wrapped(9), nonce()])

    await expect(
      db.as(USER_B, INSERT, [USER_B, 'device', null, deviceId, publicKey, wrapped(10), nonce()]),
    ).rejects.toThrow(/root_key_wraps_one_per_device/u)
  })

  it('rejects a payload that is not an AES-GCM wrap of 32 bytes', async () => {
    // 32 plaintext bytes plus a 16-byte tag. A shorter value cannot be a sealed root key,
    // whatever it claims — and a truncated one would derive field keys that open nothing.
    await expect(
      db.as(USER_B, INSERT, [
        USER_B,
        'recovery',
        null,
        null,
        null,
        new Uint8Array(32).fill(1) as Uint8Array<ArrayBuffer>,
        nonce(),
      ]),
    ).rejects.toThrow(/root_key_wraps_length/u)
  })

  it('rejects a device public key that is not an uncompressed P-256 point', async () => {
    await expect(
      db.as(
        USER_B,
        `insert into public.devices (user_id, label, public_key) values ($1, 'Bad', $2)`,
        [USER_B, new Uint8Array(32).fill(1) as Uint8Array<ArrayBuffer>],
      ),
    ).rejects.toThrow(/devices_public_key_length/u)
  })

  it('no longer carries a wrapped_root_key column on devices', async () => {
    // 0001 put one there before there was anywhere to record the ephemeral public key an
    // ECIES wrap needs. Two homes for the same fact is one too many.
    const { rows } = await db.raw(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'devices'`,
    )
    expect(rows.map((r) => r.column_name)).not.toContain('wrapped_root_key')
  })

  /**
   * Changing a password rewrites exactly one row, and that row is the one thing standing
   * between a user and their calendar. These cover the write itself.
   *
   * The zero-row case is the one worth having. RLS does not raise on an UPDATE that matches
   * nothing — it silently affects no rows — so "no error" is not the same as "it worked". The
   * application half sets the new account password immediately afterwards, and if the wrap
   * write had quietly done nothing, that pair would lock the user out completely. The client
   * asks for the updated rows back and refuses to continue unless exactly one comes.
   */
  describe('rewrapping the password wrap', () => {
    const REWRAP = `update public.root_key_wraps
         set wrapped = $1, nonce = $2, kdf = $3::jsonb
       where user_id = $4 and kind = 'password'
       returning id`

    it('replaces the sealed bytes in place', async () => {
      const user = '00000000-0000-4000-8000-0000000000c1'
      await db.createUser(user, 'c1@example.com')
      await db.as(user, INSERT, [user, 'password', KDF, null, null, wrapped(1), nonce()])

      const { rows } = await db.as(user, REWRAP, [wrapped(2), nonce(), KDF, user])
      expect(rows).toHaveLength(1)

      const after = await db.as(
        user,
        `select get_byte(wrapped, 0) as first from public.root_key_wraps
          where user_id = $1 and kind = 'password'`,
        [user],
      )
      expect(after.rows[0]!['first']).toBe(2)
    })

    it('still allows exactly one password wrap afterwards', async () => {
      // An UPDATE cannot fork the account the way a second INSERT would, but assert it rather
      // than assume it: the partial unique index is what makes "the password wrap" singular,
      // and a rewrap that appended instead of replacing would leave the retired password
      // still opening the calendar.
      const user = '00000000-0000-4000-8000-0000000000c1'
      const { rows } = await db.as(
        user,
        `select count(*)::int as n from public.root_key_wraps where user_id = $1 and kind = 'password'`,
        [user],
      )
      expect(rows[0]!['n']).toBe(1)
    })

    it('touches updated_at, so a rewrap is visible in the row itself', async () => {
      const user = '00000000-0000-4000-8000-0000000000c2'
      await db.createUser(user, 'c2@example.com')
      await db.as(user, INSERT, [user, 'password', KDF, null, null, wrapped(1), nonce()])

      await db.raw(
        `update public.root_key_wraps set updated_at = now() - interval '1 day'
          where user_id = $1 and kind = 'password'`,
        [user],
      )
      await db.as(user, REWRAP, [wrapped(3), nonce(), KDF, user])

      const { rows } = await db.as(
        user,
        `select updated_at > created_at as touched from public.root_key_wraps
          where user_id = $1 and kind = 'password'`,
        [user],
      )
      expect(rows[0]!['touched']).toBe(true)
    })

    it('affects nothing when the row belongs to someone else', async () => {
      // Not an error — no rows. That silence is exactly why the client checks the row count
      // instead of only checking for an error.
      const victim = '00000000-0000-4000-8000-0000000000c3'
      await db.createUser(victim, 'c3@example.com')
      await db.as(victim, INSERT, [victim, 'password', KDF, null, null, wrapped(9), nonce()])

      const { rows } = await db.as(USER_B, REWRAP, [wrapped(4), nonce(), KDF, victim])
      expect(rows).toEqual([])

      const after = await db.as(
        victim,
        `select get_byte(wrapped, 0) as first from public.root_key_wraps
          where user_id = $1 and kind = 'password'`,
        [victim],
      )
      expect(after.rows[0]!['first']).toBe(9)
    })

    it('cannot be reassigned to another user', async () => {
      // WITH CHECK governs what the row may BECOME. Without it, an update could hand your
      // wrap to somebody else's account.
      const user = '00000000-0000-4000-8000-0000000000c4'
      await db.createUser(user, 'c4@example.com')
      await db.as(user, INSERT, [user, 'password', KDF, null, null, wrapped(1), nonce()])

      await expect(
        db.as(user, `update public.root_key_wraps set user_id = $1 where user_id = $2`, [
          USER_B,
          user,
        ]),
      ).rejects.toThrow(/row-level security/i)
    })

    it('is not rewritable by an unauthenticated caller', async () => {
      const { rows } = await db.asUnauthenticated(REWRAP, [
        wrapped(5),
        nonce(),
        KDF,
        '00000000-0000-4000-8000-0000000000c1',
      ]).catch(() => ({ rows: [] as unknown[] }))
      expect(rows).toEqual([])
    })
  })
})
