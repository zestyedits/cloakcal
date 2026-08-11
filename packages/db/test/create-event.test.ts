import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { USER_A, USER_B, createTestDb, type TestDb } from './harness.js'

/**
 * create_cloaked_event — the one path a browser writes an event through.
 *
 * The function exists for atomicity, not privilege: it is SECURITY INVOKER, so every
 * statement inside it is subject to the same RLS the caller faces outside it. These tests
 * exist to prove that claim rather than to trust the keyword — a definer-rights version
 * would pass every happy-path test in this file and fail the cross-workspace ones, which is
 * exactly why the cross-workspace ones are here.
 *
 * The other thing under test is that unencrypted content cannot get in. There is no
 * parameter for a title, the algorithm enum has one value, and a payload too short to be
 * AES-GCM output is rejected before it reaches a column.
 */

/** Realistic shape: 16-byte tag plus a few bytes of ciphertext. */
const ciphertext = (byte: number) => Buffer.from(new Uint8Array(24).fill(byte)).toString('hex')
const nonce = () => Buffer.from(new Uint8Array(12).fill(9)).toString('hex')

const field = (name: string, byte: number) => ({
  field_name: name,
  ciphertext: ciphertext(byte),
  nonce: nonce(),
  alg: 'aes-256-gcm-v1',
  key_version: 1,
})

const CALL = `select public.create_cloaked_event(
    $1::uuid, $2::uuid, $3::uuid, $4::text, $5::timestamptz, $6::timestamptz,
    $7::timestamp, false, null, null, $8::text, 'busy', $9::jsonb
  ) as id`

describe('create_cloaked_event', () => {
  let db: TestDb
  let workspaceA: string
  let calendarA: string
  let workspaceB: string
  let calendarB: string

  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

  beforeAll(async () => {
    db = await createTestDb()
    await db.createUser(USER_A, 'a@example.com')
    await db.createUser(USER_B, 'b@example.com')

    const make = async (user: string) => {
      const ws = await db.as(
        user,
        'insert into public.workspaces (owner_id) values ($1) returning id',
        [user],
      )
      const workspaceId = (ws.rows[0] as { id: string }).id
      const cal = await db.as(
        user,
        'insert into public.calendars (workspace_id, is_default) values ($1, true) returning id',
        [workspaceId],
      )
      return [workspaceId, (cal.rows[0] as { id: string }).id] as const
    }

    ;[workspaceA, calendarA] = await make(USER_A)
    ;[workspaceB, calendarB] = await make(USER_B)
  })

  afterAll(async () => {
    await db.close()
  })

  it('writes the event and its sealed fields together', async () => {
    const id = uuid(1)
    await db.as(USER_A, CALL, [
      id,
      workspaceA,
      calendarA,
      'America/New_York',
      '2026-05-19T13:00:00Z',
      '2026-05-19T13:30:00Z',
      '2026-05-19 09:00:00',
      null,
      JSON.stringify([field('title', 1), field('location', 2)]),
    ])

    const { rows } = await db.as(
      USER_A,
      `select field_name, octet_length(ciphertext) as len, alg::text as alg
         from public.cloaked_fields where subject_id = $1 order by field_name`,
      [id],
    )
    expect(rows).toEqual([
      { field_name: 'location', len: 24, alg: 'aes-256-gcm-v1' },
      { field_name: 'title', len: 24, alg: 'aes-256-gcm-v1' },
    ])
  })

  it('keeps the local wall clock as written, not as the host machine reads it', async () => {
    // Asked for as text. Letting the driver hand back a Date would reinterpret a
    // zone-less timestamp in the host's zone, which is the bug that made 09:00 read as
    // 17:00 during M1.
    const { rows } = await db.as(
      USER_A,
      `select to_char(dtstart_local, 'YYYY-MM-DD"T"HH24:MI:SS') as local from public.events where id = $1`,
      [uuid(1)],
    )
    expect(rows[0]).toEqual({ local: '2026-05-19T09:00:00' })
  })

  it('records the write in the audit log without naming anything', async () => {
    const { rows } = await db.as(
      USER_A,
      `select action, detail from public.audit_log where subject_id = $1`,
      [uuid(1)],
    )
    expect(rows).toHaveLength(1)
    const entry = rows[0] as { action: string; detail: Record<string, unknown> }
    expect(entry.action).toBe('event.create')
    expect(entry.detail).toEqual({ field_count: 2, recurring: false })
    // The whole row, serialized, must not contain anything that looks like content.
    expect(JSON.stringify(entry)).not.toMatch(/title|location|notes/u)
  })

  it('rejects a payload too short to be AES-GCM output', async () => {
    // A client that skipped encryption, or hex that failed to decode. Either way it must
    // not reach a column even once — there is no later pass that would notice.
    await expect(
      db.as(USER_A, CALL, [
        uuid(2),
        workspaceA,
        calendarA,
        'America/New_York',
        '2026-05-19T13:00:00Z',
        '2026-05-19T13:30:00Z',
        '2026-05-19 09:00:00',
        null,
        JSON.stringify([
          { field_name: 'title', ciphertext: Buffer.from('Lunch').toString('hex'), nonce: nonce(), alg: 'aes-256-gcm-v1', key_version: 1 },
        ]),
      ]),
    ).rejects.toThrow(/too short to be AES-GCM output/u)
  })

  it('writes no event when a field is rejected', async () => {
    // The reason the function exists. Without one transaction, the event above would have
    // survived its failed title and rendered as "Private event" forever.
    const { rows } = await db.as(USER_A, 'select id from public.events where id = $1', [uuid(2)])
    expect(rows).toEqual([])
  })

  it('cannot name an algorithm that is not real AEAD', async () => {
    await expect(
      db.as(USER_A, CALL, [
        uuid(3),
        workspaceA,
        calendarA,
        'America/New_York',
        '2026-05-19T13:00:00Z',
        '2026-05-19T13:30:00Z',
        '2026-05-19 09:00:00',
        null,
        JSON.stringify([{ ...field('title', 3), alg: 'plaintext-v0' }]),
      ]),
    ).rejects.toThrow(/invalid input value for enum/u)
  })

  it('refuses to write into another user workspace', async () => {
    // SECURITY INVOKER is what makes this fail. A definer-rights version would pass every
    // other test in this file and quietly succeed here.
    await expect(
      db.as(USER_B, CALL, [
        uuid(4),
        workspaceA,
        calendarA,
        'America/New_York',
        '2026-05-19T13:00:00Z',
        '2026-05-19T13:30:00Z',
        '2026-05-19 09:00:00',
        null,
        JSON.stringify([field('title', 4)]),
      ]),
    ).rejects.toThrow(/row-level security/iu)
  })

  it('leaves nothing behind after a denied cross-workspace write', async () => {
    const { rows } = await db.raw('select id from public.cloaked_fields where subject_id = $1', [
      uuid(4),
    ])
    expect(rows).toEqual([])
  })

  it('lets user B write freely in their own workspace', async () => {
    await db.as(USER_B, CALL, [
      uuid(5),
      workspaceB,
      calendarB,
      'Europe/London',
      '2026-05-20T09:00:00Z',
      '2026-05-20T10:00:00Z',
      '2026-05-20 10:00:00',
      'FREQ=WEEKLY',
      JSON.stringify([field('title', 5)]),
    ])

    const { rows } = await db.as(USER_B, 'select rrule from public.events where id = $1', [uuid(5)])
    expect(rows).toEqual([{ rrule: 'FREQ=WEEKLY' }])
  })

  it('keeps user A unable to see any of it', async () => {
    const { rows } = await db.as(USER_A, 'select id from public.events where id = $1', [uuid(5)])
    expect(rows).toEqual([])
  })

  it('is not callable anonymously', async () => {
    await expect(
      db.asAnon(CALL, [
        uuid(6),
        workspaceA,
        calendarA,
        'America/New_York',
        '2026-05-19T13:00:00Z',
        '2026-05-19T13:30:00Z',
        '2026-05-19 09:00:00',
        null,
        JSON.stringify([field('title', 6)]),
      ]),
    ).rejects.toThrow()
  })

  it('is not callable by the unauthenticated role at all', async () => {
    // The test above uses the authenticated role with no subject. This one uses Supabase's
    // `anon` role, which is what an unauthenticated HTTP request really is — and which held
    // an execute grant in production until migration 0009, because the `revoke ... from
    // public` here never applied to it.
    await expect(
      db.asUnauthenticated(CALL, [
        uuid(7),
        workspaceA,
        calendarA,
        'America/New_York',
        '2026-05-19T13:00:00Z',
        '2026-05-19T13:30:00Z',
        '2026-05-19 09:00:00',
        null,
        JSON.stringify([field('title', 7)]),
      ]),
    ).rejects.toThrow(/permission denied/iu)
  })

  it('runs as invoker, so it grants no privilege the caller lacked', async () => {
    const { rows } = await db.raw(
      `select prosecdef from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'create_cloaked_event'`,
    )
    expect(rows).toEqual([{ prosecdef: false }])
  })
})
