import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { USER_A, USER_B, createTestDb, type TestDb } from './harness.js'

/**
 * update_calendar (0019) — rename (sealed) and recolour (Tier A).
 *
 * The rename path reuses the cloaked_fields upsert shape from contacts; what is specific
 * here is the colour allowlist (the tokens that actually have CSS) and that a trashed
 * calendar is not editable.
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

describe('update_calendar', () => {
  let db: TestDb
  let ws: string
  let calendar: string
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

  const nameField = (byte = 1) =>
    JSON.stringify([
      { field_name: 'display_name', ciphertext: ciphertext(byte), nonce: NONCE, alg: 'aes-256-gcm-v1' },
    ])

  const update = (user: string, id: string, color: string | null, fields = '[]') =>
    db.as(user, 'select public.update_calendar($1::uuid, $2::text, $3::jsonb)', [id, color, fields])

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
    const cal = await db.as(
      USER_A,
      "insert into public.calendars (workspace_id) values ($1) returning id",
      [ws],
    )
    calendar = cal.rows[0]!['id'] as string
  })

  afterAll(async () => {
    await db.close()
  })

  it('recolours within the allowlist', async () => {
    await update(USER_A, calendar, 'teal')
    const { rows } = await db.as(USER_A, 'select color_token from public.calendars')
    expect(rows[0]!['color_token']).toBe('teal')
  })

  it('refuses a colour that has no CSS behind it', async () => {
    // An unknown token silently renders the slate fallback, which looks like a bug —
    // refused loudly instead.
    expect(await hintOf(update(USER_A, calendar, 'chartreuse'))).toBe('unknown_color')
  })

  it('replaces the sealed name', async () => {
    await update(USER_A, calendar, null, nameField(1))
    await update(USER_A, calendar, null, nameField(2))
    const { rows } = await db.as(
      USER_A,
      "select count(*)::int as n from public.cloaked_fields where subject_type = 'calendar' and subject_id = $1",
      [calendar],
    )
    // A rename UPDATES the one row; it must not accumulate a history of ciphertexts.
    expect(rows[0]!['n']).toBe(1)
  })

  it('refuses a name that was never encrypted', async () => {
    expect(
      await hintOf(
        update(
          USER_A,
          calendar,
          null,
          JSON.stringify([
            { field_name: 'display_name', ciphertext: '00', nonce: NONCE, alg: 'aes-256-gcm-v1' },
          ]),
        ),
      ),
    ).toBe('not_ciphertext')
  })

  it('makes someone else\'s calendar look missing, not forbidden', async () => {
    expect(await hintOf(update(USER_B, calendar, 'rose'))).toBe('calendar_not_found')
  })

  it('refuses a calendar that does not exist', async () => {
    expect(await hintOf(update(USER_A, uuid(9), 'rose'))).toBe('calendar_not_found')
  })

  it('refuses a trashed calendar', async () => {
    const { rows } = await db.as(
      USER_A,
      "insert into public.calendars (workspace_id, lifecycle) values ($1, 'trashed') returning id",
      [ws],
    )
    expect(await hintOf(update(USER_A, rows[0]!['id'] as string, 'rose'))).toBe(
      'calendar_not_found',
    )
  })

  it('is not callable without a session', async () => {
    await expect(
      db.asUnauthenticated('select public.update_calendar($1::uuid, $2::text, $3::jsonb)', [
        calendar,
        'teal',
        '[]',
      ]),
    ).rejects.toThrow()
  })
})
