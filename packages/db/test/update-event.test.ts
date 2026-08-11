import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloakField, rootKeyFromSeedBytes, uncloakField } from '@cloakcal/crypto'
import { createTestDb, USER_A, USER_B, type TestDb } from './harness.js'

/**
 * update_cloaked_event — the path a browser edits an event through.
 *
 * Same two things under test as the other RPCs: that SECURITY INVOKER genuinely means RLS
 * applies, and that the version guard turns a concurrent edit into a refusal rather than a
 * silent overwrite. Plus one specific to editing — a field cleared by the user must leave no
 * row behind, because an empty encrypted string renders as an untitled event rather than as
 * absence.
 *
 * The read-back check gets a falsification test. A verification step nobody has ever seen
 * fail is indistinguishable from a verification step that does nothing.
 */

const KEY = rootKeyFromSeedBytes(new Uint8Array(32).fill(7))

let db: TestDb
let wsA: string
let calA: string

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

const sealed = async (eventId: string, name: string, value: string) => {
  const p = await cloakField(KEY, { type: 'event', id: eventId }, name, value)
  return {
    field_name: name,
    ciphertext: hex(p.ciphertext),
    nonce: hex(p.nonce),
    alg: p.alg,
    key_version: p.keyVersion,
  }
}

const CREATE = `select public.create_cloaked_event(
    $1::uuid, $2::uuid, $3::uuid, $4::text, $5::timestamptz, $6::timestamptz,
    $7::timestamp, false, null, null, $8::text, 'busy', $9::jsonb
  ) as id`

const UPDATE = `select public.update_cloaked_event(
    $1::uuid, $2::integer, $3::text, $4::text, $5::text, $6::jsonb, $7::text[]
  )`

/** A plain, non-recurring event owned by user A, with a title and notes. */
const makeEvent = async (rrule: string | null = null) => {
  const id = randomUUID()
  await db.as(USER_A, CREATE, [
    id,
    wsA,
    calA,
    'America/New_York',
    '2026-05-19T13:00:00Z',
    '2026-05-19T13:30:00Z',
    '2026-05-19 09:00:00',
    rrule,
    JSON.stringify([await sealed(id, 'title', 'Lunch'), await sealed(id, 'notes', 'bring the deck')]),
  ])
  return id
}

const readField = async (eventId: string, name: string): Promise<string | null> => {
  const { rows } = await db.as(
    USER_A,
    `select ciphertext, nonce, key_version from public.cloaked_fields
      where subject_id = $1 and field_name = $2`,
    [eventId, name],
  )
  if (rows.length === 0) return null
  return uncloakField(KEY, { type: 'event', id: eventId }, name, {
    ciphertext: new Uint8Array(rows[0]!['ciphertext'] as Uint8Array),
    nonce: new Uint8Array(rows[0]!['nonce'] as Uint8Array),
    alg: 'aes-256-gcm-v1',
    keyVersion: Number(rows[0]!['key_version']),
  })
}

beforeEach(async () => {
  db = await createTestDb()
  await db.createUser(USER_A, 'a@example.test')
  await db.createUser(USER_B, 'b@example.test')
  const ws = await db.as(USER_A, 'insert into public.workspaces (owner_id) values ($1) returning id', [
    USER_A,
  ])
  wsA = ws.rows[0]!['id'] as string
  const cal = await db.as(
    USER_A,
    'insert into public.calendars (workspace_id, is_default) values ($1, true) returning id',
    [wsA],
  )
  calA = cal.rows[0]!['id'] as string
})

afterEach(async () => {
  await db.close()
})

describe('editing content', () => {
  it('replaces a field and leaves the others alone', async () => {
    const id = await makeEvent()
    await db.as(USER_A, UPDATE, [id, 1, null, null, null, JSON.stringify([await sealed(id, 'title', 'Dinner')]), []])

    expect(await readField(id, 'title')).toBe('Dinner')
    // Untouched fields keep working: same subject id, so the AAD is unchanged and there was
    // never any need to re-send them.
    expect(await readField(id, 'notes')).toBe('bring the deck')
  })

  it('adds a field that did not exist before', async () => {
    const id = await makeEvent()
    await db.as(USER_A, UPDATE, [id, 1, null, null, null, JSON.stringify([await sealed(id, 'location', 'Pier 5')]), []])
    expect(await readField(id, 'location')).toBe('Pier 5')
  })

  it('removes a cleared field entirely rather than storing an empty one', async () => {
    // An empty encrypted string is a row that decrypts to nothing and renders as an
    // untitled event. Absence is the honest representation of "I deleted my notes".
    const id = await makeEvent()
    await db.as(USER_A, UPDATE, [id, 1, null, null, null, '[]', ['notes']])

    const { rows } = await db.as(
      USER_A,
      `select field_name from public.cloaked_fields where subject_id = $1 order by field_name`,
      [id],
    )
    expect(rows).toEqual([{ field_name: 'title' }])
  })

  it('bumps the event version once, whatever was changed', async () => {
    const id = await makeEvent()
    await db.as(USER_A, UPDATE, [id, 1, null, null, null, JSON.stringify([await sealed(id, 'title', 'x')]), []])
    const { rows } = await db.as(USER_A, 'select version from public.events where id = $1', [id])
    expect(rows[0]!['version']).toBe(2)
  })

  it('rejects a payload too short to be AES-GCM output', async () => {
    const id = await makeEvent()
    await expect(
      db.as(USER_A, UPDATE, [
        id,
        1,
        null,
        null,
        null,
        JSON.stringify([
          { field_name: 'title', ciphertext: Buffer.from('Lunch').toString('hex'), nonce: '00'.repeat(12), alg: 'aes-256-gcm-v1', key_version: 1 },
        ]),
        [],
      ]),
    ).rejects.toThrow(/too short to be AES-GCM output/u)
  })

  it('writes nothing when a field is rejected', async () => {
    const id = await makeEvent()
    await db
      .as(USER_A, UPDATE, [
        id,
        1,
        null,
        null,
        null,
        JSON.stringify([
          await sealed(id, 'title', 'Dinner'),
          { field_name: 'notes', ciphertext: '00'.repeat(4), nonce: '00'.repeat(12), alg: 'aes-256-gcm-v1', key_version: 1 },
        ]),
        [],
      ])
      .catch(() => undefined)

    // The good field was written BEFORE the bad one raised, so this only passes because the
    // whole function is one transaction.
    expect(await readField(id, 'title')).toBe('Lunch')
    const { rows } = await db.as(USER_A, 'select version from public.events where id = $1', [id])
    expect(rows[0]!['version']).toBe(1)
  })
})

describe('editing timing', () => {
  it('moves a non-recurring event and keeps the wall clock exactly as written', async () => {
    const id = await makeEvent()
    await db.as(USER_A, UPDATE, [
      id,
      1,
      '2026-05-20T14:30:00',
      '2026-05-20T18:30:00Z',
      '2026-05-20T19:00:00Z',
      '[]',
      [],
    ])

    const { rows } = await db.as(
      USER_A,
      `select to_char(dtstart_local, 'YYYY-MM-DD"T"HH24:MI:SS') as local from public.events where id = $1`,
      [id],
    )
    expect(rows[0]).toEqual({ local: '2026-05-20T14:30:00' })
  })

  it('refuses a local time carrying a timezone offset', async () => {
    // THE REASON THE PARAMETER IS TEXT. Postgres parses
    // `timestamp '2026-05-20T14:30:00+05:00'` to 14:30 and drops the offset silently, so a
    // typed parameter would store an anchor five hours off what the user picked — and a
    // read-back comparing against that same parse would pass.
    const id = await makeEvent()
    await expect(
      db.as(USER_A, UPDATE, [
        id,
        1,
        '2026-05-20T14:30:00+05:00',
        '2026-05-20T18:30:00Z',
        '2026-05-20T19:00:00Z',
        '[]',
        [],
      ]),
    ).rejects.toThrow(/not YYYY-MM-DDTHH:MM:SS/u)
  })

  it('refuses an instant that is not UTC', async () => {
    const id = await makeEvent()
    await expect(
      db.as(USER_A, UPDATE, [id, 1, '2026-05-20T14:30:00', '2026-05-20T18:30:00+05:00', '2026-05-20T19:00:00Z', '[]', []]),
    ).rejects.toThrow(/ISO UTC instant/u)
  })

  it('refuses to retime a recurring series', async () => {
    // Moving the anchor would strand every recurrence_exceptions row on the old wall time,
    // resurrecting cancelled occurrences. Refused rather than half-done.
    const id = await makeEvent('FREQ=WEEKLY')
    await expect(
      db.as(USER_A, UPDATE, [id, 1, '2026-05-20T14:30:00', '2026-05-20T18:30:00Z', '2026-05-20T19:00:00Z', '[]', []]),
    ).rejects.toThrow(/cannot retime a recurring series/u)
  })

  it('still lets a recurring series change its content', async () => {
    // The refusal above must be about TIMING only, or editing a repeating event's title
    // would be impossible — which is most of what the feature is for.
    const id = await makeEvent('FREQ=WEEKLY')
    await db.as(USER_A, UPDATE, [id, 1, null, null, null, JSON.stringify([await sealed(id, 'title', 'Standup')]), []])
    expect(await readField(id, 'title')).toBe('Standup')
  })

  it('refuses an end before its start', async () => {
    const id = await makeEvent()
    await expect(
      db.as(USER_A, UPDATE, [id, 1, '2026-05-20T14:30:00', '2026-05-20T19:00:00Z', '2026-05-20T18:30:00Z', '[]', []]),
    ).rejects.toThrow(/end is before start/u)
  })

  it('refuses a half-specified retime', async () => {
    const id = await makeEvent()
    await expect(
      db.as(USER_A, UPDATE, [id, 1, '2026-05-20T14:30:00', null, null, '[]', []]),
    ).rejects.toThrow(/all three/u)
  })
})

describe('the read-back check is real', () => {
  it('rolls back when the stored row does not match what was asked for', async () => {
    // A verification step nobody has watched fail is indistinguishable from one that does
    // nothing. This installs a trigger that mangles the stored anchor, so the check has
    // something genuine to catch.
    const id = await makeEvent()
    await db.raw(`create function public.mangle() returns trigger language plpgsql as $$
      begin
        new.dtstart_local := new.dtstart_local + interval '1 hour';
        return new;
      end $$`)
    await db.raw(`create trigger mangle_events before update on public.events
                    for each row execute function public.mangle()`)

    try {
      await expect(
        db.as(USER_A, UPDATE, [id, 1, '2026-05-20T14:30:00', '2026-05-20T18:30:00Z', '2026-05-20T19:00:00Z', '[]', []]),
      ).rejects.toThrow(/does not match the requested change/u)

      const { rows } = await db.as(
        USER_A,
        `select to_char(dtstart_local, 'YYYY-MM-DD"T"HH24:MI:SS') as local, version
           from public.events where id = $1`,
        [id],
      )
      expect(rows[0]).toEqual({ local: '2026-05-19T09:00:00', version: 1 })
    } finally {
      await db.raw('drop trigger mangle_events on public.events')
      await db.raw('drop function public.mangle()')
    }
  })

  it('and the same call succeeds once the trigger is gone', async () => {
    // The positive control. Without it, the test above could be passing because the call
    // fails for some unrelated reason.
    const id = await makeEvent()
    await db.as(USER_A, UPDATE, [id, 1, '2026-05-20T14:30:00', '2026-05-20T18:30:00Z', '2026-05-20T19:00:00Z', '[]', []])
    const { rows } = await db.as(
      USER_A,
      `select to_char(dtstart_local, 'YYYY-MM-DD"T"HH24:MI:SS') as local from public.events where id = $1`,
      [id],
    )
    expect(rows[0]).toEqual({ local: '2026-05-20T14:30:00' })
  })
})

describe('concurrency and access', () => {
  it('refuses a stale version', async () => {
    const id = await makeEvent()
    await expect(
      db.as(USER_A, UPDATE, [id, 99, null, null, null, JSON.stringify([await sealed(id, 'title', 'x')]), []]),
    ).rejects.toThrow(/changed by someone else/u)
    expect(await readField(id, 'title')).toBe('Lunch')
  })

  it('refuses to edit a trashed event', async () => {
    const id = await makeEvent()
    await db.as(USER_A, `select public.trash_cloaked_event($1::uuid, 1)`, [id])
    await expect(
      db.as(USER_A, UPDATE, [id, 2, null, null, null, JSON.stringify([await sealed(id, 'title', 'x')]), []]),
    ).rejects.toThrow(/is trashed/u)
  })

  it('reports a missing event as missing', async () => {
    await expect(db.as(USER_A, UPDATE, [randomUUID(), 1, null, null, null, '[]', []])).rejects.toThrow(
      /does not exist/u,
    )
  })

  it('will not let another user edit your event', async () => {
    const id = await makeEvent()
    // RLS hides the row from user B, so the function cannot tell them apart from a bad id.
    await expect(
      db.as(USER_B, UPDATE, [id, 1, null, null, null, JSON.stringify([await sealed(id, 'title', 'hijack')]), []]),
    ).rejects.toThrow(/does not exist/u)
    expect(await readField(id, 'title')).toBe('Lunch')
  })

  it('is not callable by the unauthenticated role', async () => {
    await expect(
      db.asUnauthenticated(UPDATE, [randomUUID(), 1, null, null, null, '[]', []]),
    ).rejects.toThrow(/permission denied/iu)
  })

  it('runs as invoker, so it grants no privilege the caller lacked', async () => {
    const { rows } = await db.raw(
      `select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'update_cloaked_event'`,
    )
    expect(rows).toEqual([{ prosecdef: false }])
  })
})

describe('the audit trail says what happened without saying what it said', () => {
  it('records metadata only', async () => {
    const id = await makeEvent()
    await db.as(USER_A, UPDATE, [id, 1, null, null, null, JSON.stringify([await sealed(id, 'title', 'Dinner')]), ['notes']])

    const { rows } = await db.as(
      USER_A,
      `select action, detail from public.audit_log where subject_id = $1 and action = 'event.updated'`,
      [id],
    )
    expect(rows).toHaveLength(1)
    const entry = rows[0] as { detail: Record<string, unknown> }
    expect(entry.detail).toEqual({
      from_version: 1,
      retimed: false,
      fields_set: 1,
      fields_cleared: 1,
    })
    expect(JSON.stringify(entry)).not.toMatch(/Dinner|Lunch|deck/u)
  })
})
