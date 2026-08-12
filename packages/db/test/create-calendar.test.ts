import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { USER_A, USER_B, createTestDb, type TestDb } from './harness.js'

/**
 * create_calendar (0021) — the first way a calendar has ever been made outside
 * bootstrapWorkspace().
 *
 * The properties worth pinning: a created calendar is never the default (the partial
 * unique index owns that, and is_default is not even a parameter), the sealed name is
 * mandatory in the same transaction, and a foreign workspace reads as missing rather
 * than forbidden.
 */

const ciphertext = (byte: number) => Buffer.from(new Uint8Array(24).fill(byte)).toString('hex')
const NONCE = Buffer.from(new Uint8Array(12).fill(7)).toString('hex')

const hintOf = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run
  } catch (caught) {
    return (caught as { hint?: string }).hint ?? `NO HINT: ${String(caught)}`
  }
  return 'NO ERROR'
}

describe('create_calendar', () => {
  let db: TestDb
  let ws: string
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

  const nameField = (byte = 1) =>
    JSON.stringify([
      { field_name: 'display_name', ciphertext: ciphertext(byte), nonce: NONCE, alg: 'aes-256-gcm-v1' },
    ])

  const create = (user: string, id: string, workspace: string, color: string, fields: string) =>
    db.as(user, 'select public.create_calendar($1::uuid, $2::uuid, $3::text, $4::jsonb)', [
      id,
      workspace,
      color,
      fields,
    ])

  beforeAll(async () => {
    db = await createTestDb()
    await db.createUser(USER_A, 'a@example.test')
    await db.createUser(USER_B, 'b@example.test')
    const { rows } = await db.as(
      USER_A,
      'insert into public.workspaces (owner_id) values ($1) returning id',
      [USER_A],
    )
    ws = rows[0]!['id'] as string
    // The bootstrap-shaped default calendar the new ones must not disturb.
    await db.as(
      USER_A,
      'insert into public.calendars (workspace_id, is_default, sort_order) values ($1, true, 0)',
      [ws],
    )
  })

  afterAll(async () => {
    await db.close()
  })

  it('creates an ordinary calendar with its sealed name, after the existing ones', async () => {
    await create(USER_A, uuid(1), ws, 'teal', nameField(1))

    const { rows } = await db.as(
      USER_A,
      'select color_token, is_default, sort_order from public.calendars where id = $1',
      [uuid(1)],
    )
    expect(rows[0]).toEqual({ color_token: 'teal', is_default: false, sort_order: 1 })

    const sealed = await db.as(
      USER_A,
      "select count(*)::int as n from public.cloaked_fields where subject_type = 'calendar' and subject_id = $1",
      [uuid(1)],
    )
    expect(sealed.rows[0]!['n']).toBe(1)
  })

  it('never disturbs the default, however many are created', async () => {
    await create(USER_A, uuid(2), ws, 'rose', nameField(2))
    const { rows } = await db.as(
      USER_A,
      'select count(*)::int as n from public.calendars where workspace_id = $1 and is_default',
      [ws],
    )
    expect(rows[0]!['n']).toBe(1)
  })

  it('appends sort_order across creates', async () => {
    const { rows } = await db.as(
      USER_A,
      'select sort_order from public.calendars where workspace_id = $1 order by sort_order',
      [ws],
    )
    expect(rows.map((r) => r['sort_order'])).toEqual([0, 1, 2])
  })

  it("makes someone else's workspace look missing, not forbidden", async () => {
    expect(await hintOf(create(USER_B, uuid(3), ws, 'teal', nameField(3)))).toBe(
      'workspace_not_found',
    )
  })

  it('refuses a workspace that does not exist', async () => {
    expect(await hintOf(create(USER_A, uuid(4), uuid(9), 'teal', nameField(4)))).toBe(
      'workspace_not_found',
    )
  })

  it('refuses a colour that has no CSS behind it', async () => {
    expect(await hintOf(create(USER_A, uuid(5), ws, 'chartreuse', nameField(5)))).toBe(
      'unknown_color',
    )
  })

  it('refuses a name that was never encrypted, and rolls the row back', async () => {
    expect(
      await hintOf(
        create(
          USER_A,
          uuid(6),
          ws,
          'teal',
          JSON.stringify([
            { field_name: 'display_name', ciphertext: '00', nonce: NONCE, alg: 'aes-256-gcm-v1' },
          ]),
        ),
      ),
    ).toBe('not_ciphertext')
    const { rows } = await db.as(
      USER_A,
      'select count(*)::int as n from public.calendars where id = $1',
      [uuid(6)],
    )
    expect(rows[0]!['n']).toBe(0)
  })

  it('refuses a calendar with no sealed name at all', async () => {
    // A calendar with no name renders the placeholder forever, indistinguishable from a
    // decryption failure — refused in the same transaction as the insert.
    expect(await hintOf(create(USER_A, uuid(7), ws, 'teal', '[]'))).toBe('missing_name')
    const { rows } = await db.as(
      USER_A,
      'select count(*)::int as n from public.calendars where id = $1',
      [uuid(7)],
    )
    expect(rows[0]!['n']).toBe(0)
  })

  it('is not callable without a session', async () => {
    await expect(
      db.asUnauthenticated(
        'select public.create_calendar($1::uuid, $2::uuid, $3::text, $4::jsonb)',
        [uuid(8), ws, 'teal', nameField(8)],
      ),
    ).rejects.toThrow()
  })
})
