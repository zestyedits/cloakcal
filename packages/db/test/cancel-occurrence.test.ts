import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { USER_A, USER_B, createTestDb, type TestDb } from './harness.js'

/**
 * cancel_occurrence — deleting one Tuesday without deleting every Tuesday.
 *
 * Tested for the same two invariants as every other RPC — that SECURITY INVOKER genuinely
 * means RLS applies, and that the version guard turns a concurrent edit into a refusal — plus
 * three that are specific to subtracting an occurrence from a rule rather than deleting a row:
 *
 *   1. THE SERIES SURVIVES INTACT. No lifecycle change, no field deleted. The other
 *      occurrences still need the ciphertext, so removing it would destroy the event while
 *      appearing to remove one instance of it.
 *   2. THE KEY IS LOCAL WALL TIME, and it arrives as text. Postgres drops a timezone offset
 *      silently when parsing into `timestamp`, so a zoned string would cancel an occurrence
 *      hours from the one clicked, with no error to notice.
 *   3. A 'moved' EXCEPTION IS NOT OVERWRITTEN. That slot belongs to a detached event row;
 *      cancelling it would orphan a row that keeps rendering and is no longer reachable from
 *      the series.
 */

const ciphertext = (byte: number) => Buffer.from(new Uint8Array(24).fill(byte)).toString('hex')
const nonce = () => Buffer.from(new Uint8Array(12).fill(9)).toString('hex')

const field = (name: string, byte: number) => ({
  field_name: name,
  ciphertext: ciphertext(byte),
  nonce: nonce(),
  alg: 'aes-256-gcm-v1',
  key_version: 1,
})

const CREATE = `select public.create_cloaked_event(
    $1::uuid, $2::uuid, $3::uuid, $4::text, $5::timestamptz, $6::timestamptz,
    $7::timestamp, false, null, null, $8::text, 'busy', $9::jsonb
  ) as id`

const CANCEL = `select public.cancel_occurrence($1::uuid, $2::integer, $3::text)`

/** Slug from the exception HINT. Matching prose would make wording an interface (0012). */
const hintOf = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run
  } catch (caught) {
    const hint = (caught as { hint?: string }).hint
    return hint ?? `NO HINT: ${String(caught)}`
  }
  return 'NO ERROR'
}

describe('cancel_occurrence', () => {
  let db: TestDb
  let workspaceA: string
  let calendarA: string

  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

  /** A weekly series owned by user A, Tuesdays 09:00 New York. */
  const seedSeries = async (n: number, rrule: string | null = 'FREQ=WEEKLY;BYDAY=TU') => {
    const id = uuid(n)
    await db.as(USER_A, CREATE, [
      id,
      workspaceA,
      calendarA,
      'America/New_York',
      '2026-05-19T13:00:00Z',
      '2026-05-19T13:30:00Z',
      '2026-05-19 09:00:00',
      rrule,
      JSON.stringify([field('title', n)]),
    ])
    return id
  }

  const exceptionsOf = async (seriesId: string) => {
    const { rows } = await db.as(
      USER_A,
      `select to_char(occurrence_local, 'YYYY-MM-DD"T"HH24:MI:SS') as at,
              kind, replacement_event_id
         from public.recurrence_exceptions
        where series_id = $1
        order by occurrence_local`,
      [seriesId],
    )
    return rows
  }

  beforeAll(async () => {
    db = await createTestDb()
    await db.createUser(USER_A, 'a@example.com')
    await db.createUser(USER_B, 'b@example.com')

    const ws = await db.as(
      USER_A,
      'insert into public.workspaces (owner_id) values ($1) returning id',
      [USER_A],
    )
    workspaceA = (ws.rows[0] as { id: string }).id
    const cal = await db.as(
      USER_A,
      'insert into public.calendars (workspace_id, is_default) values ($1, true) returning id',
      [workspaceA],
    )
    calendarA = (cal.rows[0] as { id: string }).id
  })

  afterAll(async () => {
    await db.close()
  })

  it('records a cancelled exception at the occurrence wall time', async () => {
    const id = await seedSeries(1)
    await db.as(USER_A, CANCEL, [id, 1, '2026-05-26T09:00:00'])

    expect(await exceptionsOf(id)).toEqual([
      { at: '2026-05-26T09:00:00', kind: 'cancelled', replacement_event_id: null },
    ])
  })

  it('leaves the series active, with its rule and its content untouched', async () => {
    // The other occurrences still need all of it. A cancel that trashed the row or dropped
    // the ciphertext would destroy the event while looking like it removed one instance.
    const { rows } = await db.as(
      USER_A,
      `select lifecycle::text as lifecycle, rrule,
              (select count(*)::int from public.cloaked_fields where subject_id = e.id) as fields
         from public.events e where id = $1`,
      [uuid(1)],
    )
    expect(rows).toEqual([
      { lifecycle: 'active', rrule: 'FREQ=WEEKLY;BYDAY=TU', fields: 1 },
    ])
  })

  it('bumps the version, because the occurrence set the caller was looking at has changed', async () => {
    // Nothing on the row itself changed, so this is a decision rather than a side effect: a
    // second tab holding version 1 must be made to reload rather than being allowed to apply
    // an edit computed against an occurrence list that no longer exists.
    const { rows } = await db.as(USER_A, 'select version from public.events where id = $1', [
      uuid(1),
    ])
    expect(rows).toEqual([{ version: 2 }])
  })

  it('is idempotent — cancelling the same occurrence twice is not an error', async () => {
    const id = await seedSeries(2)
    await db.as(USER_A, CANCEL, [id, 1, '2026-05-26T09:00:00'])
    // A dropped response and a retry must not surface a failure for work already done.
    await db.as(USER_A, CANCEL, [id, 2, '2026-05-26T09:00:00'])

    expect(await exceptionsOf(id)).toHaveLength(1)
    const { rows } = await db.as(USER_A, 'select version from public.events where id = $1', [id])
    // And the no-op must not bump the version either, or a retry loop would walk it upward.
    expect(rows).toEqual([{ version: 2 }])
  })

  it('refuses to overwrite a moved exception, which belongs to a detached event', async () => {
    const id = await seedSeries(3)
    const detached = uuid(300)
    await db.as(USER_A, CREATE, [
      detached,
      workspaceA,
      calendarA,
      'America/New_York',
      '2026-05-26T14:00:00Z',
      '2026-05-26T14:30:00Z',
      '2026-05-26 10:00:00',
      null,
      JSON.stringify([field('title', 30)]),
    ])
    await db.as(
      USER_A,
      `insert into public.recurrence_exceptions
         (series_id, workspace_id, occurrence_local, kind, replacement_event_id)
       values ($1, $2, '2026-05-26 09:00:00', 'moved', $3)`,
      [id, workspaceA, detached],
    )

    expect(await hintOf(db.as(USER_A, CANCEL, [id, 1, '2026-05-26T09:00:00']))).toBe(
      'occurrence_detached',
    )

    // And the moved row is still intact, still pointing at its replacement.
    expect(await exceptionsOf(id)).toEqual([
      { at: '2026-05-26T09:00:00', kind: 'moved', replacement_event_id: detached },
    ])
  })

  it('refuses a non-repeating event, where "this occurrence" means the whole event', async () => {
    const id = await seedSeries(4, null)
    expect(await hintOf(db.as(USER_A, CANCEL, [id, 1, '2026-05-19T09:00:00']))).toBe('not_a_series')
    expect(await exceptionsOf(id)).toEqual([])
  })

  it('rejects a zoned string rather than silently cancelling the wrong hour', async () => {
    // `timestamp '2026-05-26T09:00:00-04:00'` parses to 09:00 and drops the offset. A client
    // that sent a zoned value would cancel an occurrence hours from the one the user clicked,
    // and nothing downstream could tell. The regex is what makes the cast total.
    const id = await seedSeries(5)
    expect(await hintOf(db.as(USER_A, CANCEL, [id, 1, '2026-05-26T09:00:00-04:00']))).toBe(
      'noncanonical_time',
    )
    expect(await hintOf(db.as(USER_A, CANCEL, [id, 1, '2026-05-26 09:00:00']))).toBe(
      'noncanonical_time',
    )
    expect(await exceptionsOf(id)).toEqual([])
  })

  it('refuses an edit based on a stale version', async () => {
    const id = await seedSeries(6)
    await db.as(USER_A, CANCEL, [id, 1, '2026-05-26T09:00:00'])
    expect(await hintOf(db.as(USER_A, CANCEL, [id, 1, '2026-06-02T09:00:00']))).toBe(
      'version_conflict',
    )
    expect(await exceptionsOf(id)).toHaveLength(1)
  })

  it('refuses an event that does not exist', async () => {
    expect(await hintOf(db.as(USER_A, CANCEL, [uuid(999), 1, '2026-05-26T09:00:00']))).toBe(
      'event_not_found',
    )
  })

  it('refuses a trashed event', async () => {
    const id = await seedSeries(7)
    await db.as(USER_A, `select public.trash_cloaked_event($1::uuid, 1)`, [id])
    expect(await hintOf(db.as(USER_A, CANCEL, [id, 2, '2026-05-26T09:00:00']))).toBe('event_trashed')
  })

  it('does not let another user cancel an occurrence of a series they cannot see', async () => {
    // SECURITY INVOKER means RLS applies to the SELECT, so user B does not find the row at
    // all — indistinguishable from a bad id, which is the correct disclosure. A definer-rights
    // version of this function would pass every test above and fail this one.
    const id = await seedSeries(8)
    expect(await hintOf(db.as(USER_B, CANCEL, [id, 1, '2026-05-26T09:00:00']))).toBe(
      'event_not_found',
    )
    expect(await exceptionsOf(id)).toEqual([])
  })

  it('is not callable without a session', async () => {
    const id = await seedSeries(9)
    await expect(db.asUnauthenticated(CANCEL, [id, 1, '2026-05-26T09:00:00'])).rejects.toThrow()
  })
})
