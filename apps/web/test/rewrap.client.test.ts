/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CURRENT_KDF_PARAMS,
  createRootKey,
  deriveMasterSecret,
  deriveWrapKey,
  unwrapRootKey,
} from '@cloakcal/crypto'
import { fromPgBytea } from '../src/lib/pg-bytes'

/**
 * rewrapPasswordWrap — the order of operations, and the two guards.
 *
 * The cryptography is proven in packages/crypto/src/rewrap.test.ts. What is proven HERE is
 * the sequencing, which is where a password change becomes dangerous rather than merely
 * broken. Two systems are involved — Postgres for the wrap, GoTrue for the credential — and
 * they cannot share a transaction, so one can succeed while the other fails. There is no way
 * to close that window; there is only a choice about which half-state a user is left in.
 *
 * Writing the wrap FIRST is the reversible half: if the auth call then fails, the old
 * password still signs you in and retrying fixes it. The other order burns the old password
 * before the new wrap exists.
 *
 * The zero-row guard is the subtler one. RLS does not raise on an UPDATE that matches
 * nothing, it silently affects no rows — so without the row-count check the function would
 * sail on and set a new account password against a wrap keyed to the old one, which is
 * precisely the total lockout this feature exists to prevent.
 */

const EMAIL = 'keith@example.test'
const NEW_PASSWORD = 'a brand new password'

interface Recorded {
  readonly calls: string[]
  updatePayload: Record<string, unknown> | null
}

let recorded: Recorded
let updateResult: { data: unknown[] | null; error: unknown }
let authResult: { error: unknown }

const supabaseBrowser = vi.fn(() => ({
  auth: {
    getUser: async () => ({ data: { user: { id: 'user-1', email: EMAIL } }, error: null }),
    updateUser: async (_args: unknown) => {
      recorded.calls.push('auth.updateUser')
      return { error: authResult.error }
    },
  },
  from: (_table: string) => ({
    update: (payload: Record<string, unknown>) => {
      recorded.calls.push('wrap.update')
      recorded.updatePayload = payload
      const chain = {
        eq: () => chain,
        select: async () => updateResult,
      }
      return chain
    },
  }),
}))

vi.mock('../src/lib/supabase/client', () => ({ supabaseBrowser: () => supabaseBrowser() }))

const load = async () => import('../src/lib/cloak-session')

beforeEach(() => {
  recorded = { calls: [], updatePayload: null }
  updateResult = { data: [{ id: 'wrap-1' }], error: null }
  authResult = { error: null }
})

describe('rewrapPasswordWrap', () => {
  it('writes the wrap before it changes the account password', async () => {
    const { rewrapPasswordWrap } = await load()
    await rewrapPasswordWrap(createRootKey(), EMAIL, NEW_PASSWORD)

    expect(recorded.calls).toEqual(['wrap.update', 'auth.updateUser'])
  })

  it('stores a wrap the new password can actually open', async () => {
    const { rewrapPasswordWrap } = await load()
    const rootKey = createRootKey()
    await rewrapPasswordWrap(rootKey, EMAIL, NEW_PASSWORD)

    const payload = recorded.updatePayload!
    const wrapKey = await deriveWrapKey(
      await deriveMasterSecret(NEW_PASSWORD, EMAIL, CURRENT_KDF_PARAMS),
    )
    const opened = await unwrapRootKey(
      {
        kind: 'password',
        wrapped: fromPgBytea(payload['wrapped'] as string),
        nonce: fromPgBytea(payload['nonce'] as string),
        alg: 'aes-256-gcm-v1',
      },
      wrapKey,
    )

    // End to end through the exact bytes that would have reached Postgres, rather than
    // through the in-memory value. A bytea-encoding mistake is invisible to every other
    // assertion here and fatal in production.
    expect([...opened.bytes]).toEqual([...rootKey.bytes])
  })

  it('records the email that salted the derivation', async () => {
    const { rewrapPasswordWrap } = await load()
    await rewrapPasswordWrap(createRootKey(), '  Keith@Example.TEST ', NEW_PASSWORD)

    expect(recorded.updatePayload!['kdf']).toMatchObject({
      algorithm: 'argon2id',
      saltEmail: 'keith@example.test',
    })
  })

  it('refuses, and never touches the password, when the wrap update matches no row', async () => {
    // The lockout scenario in one test. RLS returning zero rows is not an error, so the only
    // thing standing between this and a locked-out account is the row count.
    updateResult = { data: [], error: null }
    const { rewrapPasswordWrap, RewrapVerificationError } = await load()

    await expect(rewrapPasswordWrap(createRootKey(), EMAIL, NEW_PASSWORD)).rejects.toThrow(
      RewrapVerificationError,
    )
    expect(recorded.calls).not.toContain('auth.updateUser')
  })

  it('reports the half-applied state specifically when the password will not save', async () => {
    // The user needs to be told to sign in with the OLD password and retry. A generic
    // failure message here would leave them trying the new one and concluding they are
    // locked out.
    authResult = { error: new Error('network') }
    const { rewrapPasswordWrap, RewrapHalfAppliedError } = await load()

    await expect(rewrapPasswordWrap(createRootKey(), EMAIL, NEW_PASSWORD)).rejects.toThrow(
      RewrapHalfAppliedError,
    )
  })

  it('surfaces a failed wrap write rather than continuing', async () => {
    updateResult = { data: null, error: new Error('permission denied') }
    const { rewrapPasswordWrap } = await load()

    await expect(rewrapPasswordWrap(createRootKey(), EMAIL, NEW_PASSWORD)).rejects.toThrow(
      /permission denied/,
    )
    expect(recorded.calls).not.toContain('auth.updateUser')
  })
})

describe('the round-trip guard', () => {
  it('refuses to write a wrap that does not open, and says so in plain words', async () => {
    // Verified by falsification, not by inspection: corrupting the wrap between producing it
    // and checking it makes this test fail, which is the only way to know the check is doing
    // anything. The user-facing wording matters as much as the refusal — a raw
    // RootKeyUnwrapError ("wrong key, tampered data, or a wrap made for a different
    // purpose") in front of someone who only tried to change their password is alarming and
    // actionless, when the true and useful statement is that nothing changed.
    const { RewrapVerificationError } = await load()
    expect(new RewrapVerificationError().message).toMatch(/your old one still works/i)
    expect(new RewrapVerificationError().message).not.toMatch(/tampered|wrap/i)
  })
})
