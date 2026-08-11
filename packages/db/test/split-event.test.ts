import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { expandSeries, type ExceptionSpec } from '@cloakcal/domain'
import { createTestDb, USER_A, USER_B, type TestDb } from './harness.js'

/**
 * split_cloaked_event — the only edit that can destroy future occurrences.
 *
 * The losslessness of a split is verified in TypeScript before the call, because expanding
 * an RRULE needs a recurrence engine and there is deliberately only one of those (ADR 0001).
 * What is tested HERE is the other half: that what lands in the database is exactly the plan
 * that was verified, that the original series is truncated rather than mangled, that
 * cancelled future occurrences survive the move, and that the whole thing is one transaction.
 *
 * Several tests reach for `expandSeries` on the STORED rows rather than asserting on column
 * values. That is on purpose — a `series_id` pointing at the right row proves nothing if the
 * reader still renders the occurrence.
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

const SPLIT = `select public.split_cloaked_event(
    $1::uuid, $2::integer, $3::text, $4::text, $5::uuid,
    $6::text, $7::text, $8::text, $9::text, $10::text, $11::jsonb
  ) as id`

/** Tuesdays at 09:00 New York, from 2026-01-06. */
const SERIES_RRULE = 'FREQ=WEEKLY;BYDAY=TU'
const SPLIT_AT = '2026-03-10T09:00:00'
const RANGE = { from: '2026-01-01T00:00:00Z', to: '2026-12-31T00:00:00Z' }

let db: TestDb
let ws: string
let cal: string

const makeSeries = async (rrule: string | null = SERIES_RRULE) => {
  const id = randomUUID()
  await db.as(USER_A, CREATE, [
    id,
    ws,
    cal,
    'America/New_York',
    '2026-01-06T14:00:00Z',
    '2026-01-06T15:00:00Z',
    '2026-01-06T09:00:00',
    rrule,
    JSON.stringify([field('title', 1)]),
  ])
  return id
}

/** Read a stored row back as the domain's SeriesSpec, plus its exceptions. */
const readBack = async (id: string) => {
  const { rows } = await db.as(
    USER_A,
    `select to_char(coalesce(dtstart_local, start_utc at time zone timezone),
                    'YYYY-MM-DD"T"HH24:MI:SS')                   as dtstart_local,
            (extract(epoch from (end_utc - start_utc)) / 60)::int as duration_minutes,
            timezone, rrule, version
       from public.events where id = $1`,
    [id],
  )
  const r = rows[0]!
  const ex = await db.as(
    USER_A,
    `select to_char(occurrence_local, 'YYYY-MM-DD"T"HH24:MI:SS') as local, kind
       from public.recurrence_exceptions where series_id = $1`,
    [id],
  )
  return {
    spec: {
      dtstartLocal: String(r['dtstart_local']),
      durationMinutes: Number(r['duration_minutes']),
      timezone: String(r['timezone']),
      rrule: r['rrule'] === null ? null : String(r['rrule']),
    },
    version: Number(r['version']),
    exceptions: ex.rows.map((e) => ({
      occurrenceLocal: String(e['local']),
      kind: e['kind'] as ExceptionSpec['kind'],
    })),
  }
}

/** Everything the calendar would actually render across both halves. */
const visibleAcross = async (...ids: string[]) => {
  const out: string[] = []
  for (const id of ids) {
    const { spec, exceptions } = await readBack(id)
    out.push(...expandSeries(spec, RANGE, exceptions).map((o) => o.occurrenceLocal))
  }
  return out.sort()
}

/** A this-and-future split at SPLIT_AT, with the plan a correct client would send. */
const splitFuture = async (seriesId: string, version = 1, newId = randomUUID()) => {
  await db.as(USER_A, SPLIT, [
    seriesId,
    version,
    SPLIT_AT,
    'this-and-future',
    newId,
    `${SERIES_RRULE};UNTIL=20260310T085959Z`,
    SPLIT_AT,
    '2026-03-10T13:00:00Z',
    '2026-03-10T14:00:00Z',
    SERIES_RRULE,
    JSON.stringify([field('title', 2)]),
  ])
  return newId
}

beforeEach(async () => {
  db = await createTestDb()
  await db.createUser(USER_A, 'a@example.test')
  await db.createUser(USER_B, 'b@example.test')
  const w = await db.as(USER_A, 'insert into public.workspaces (owner_id) values ($1) returning id', [
    USER_A,
  ])
  ws = w.rows[0]!['id'] as string
  const c = await db.as(
    USER_A,
    'insert into public.calendars (workspace_id, is_default) values ($1, true) returning id',
    [ws],
  )
  cal = c.rows[0]!['id'] as string
})

afterEach(async () => {
  await db.close()
})

describe('this and future', () => {
  it('truncates the original and starts a successor at the split point', async () => {
    const seriesId = await makeSeries()
    const newId = await splitFuture(seriesId)

    const original = await readBack(seriesId)
    const successor = await readBack(newId)

    expect(original.spec.rrule).toBe(`${SERIES_RRULE};UNTIL=20260310T085959Z`)
    expect(original.version).toBe(2)
    expect(successor.spec.dtstartLocal).toBe(SPLIT_AT)
    expect(successor.spec.rrule).toBe(SERIES_RRULE)
  })

  it('reproduces the original occurrence set exactly, with no gap and no duplicate', async () => {
    // The property the whole feature rests on. Captured BEFORE the split so the comparison
    // is against what the calendar really showed, not against a re-derivation.
    const seriesId = await makeSeries()
    const before = (await visibleAcross(seriesId)).slice()

    const newId = await splitFuture(seriesId)
    const after = await visibleAcross(seriesId, newId)

    expect(after).toEqual(before)
    expect(new Set(after).size).toBe(after.length)
  })

  it('puts nothing at or after the split in the truncated half', async () => {
    const seriesId = await makeSeries()
    const newId = await splitFuture(seriesId)

    const { spec, exceptions } = await readBack(seriesId)
    const truncated = expandSeries(spec, RANGE, exceptions).map((o) => o.occurrenceLocal)
    expect(truncated.every((o) => o < SPLIT_AT)).toBe(true)

    const successor = await readBack(newId)
    const kept = expandSeries(successor.spec, RANGE, successor.exceptions).map(
      (o) => o.occurrenceLocal,
    )
    expect(kept.every((o) => o >= SPLIT_AT)).toBe(true)
  })

  it('carries a cancelled future occurrence across, so it stays cancelled', async () => {
    const seriesId = await makeSeries()
    const cancelled = '2026-03-17T09:00:00'
    await db.as(
      USER_A,
      `insert into public.recurrence_exceptions (series_id, workspace_id, occurrence_local, kind)
       values ($1, $2, $3, 'cancelled')`,
      [seriesId, ws, cancelled],
    )

    const newId = await splitFuture(seriesId)
    expect(await visibleAcross(seriesId, newId)).not.toContain(cancelled)
  })

  it('leaves a cancellation before the split with the original', async () => {
    const seriesId = await makeSeries()
    const cancelled = '2026-02-03T09:00:00'
    await db.as(
      USER_A,
      `insert into public.recurrence_exceptions (series_id, workspace_id, occurrence_local, kind)
       values ($1, $2, $3, 'cancelled')`,
      [seriesId, ws, cancelled],
    )

    const newId = await splitFuture(seriesId)
    expect((await readBack(seriesId)).exceptions.map((e) => e.occurrenceLocal)).toEqual([cancelled])
    expect((await readBack(newId)).exceptions).toEqual([])
    expect(await visibleAcross(seriesId, newId)).not.toContain(cancelled)
  })

  it('files the successor content against the id the caller supplied', async () => {
    // The caller sealed against this id before the row existed. Anything else and the
    // content is undecryptable forever.
    const seriesId = await makeSeries()
    const newId = await splitFuture(seriesId)

    const { rows } = await db.as(
      USER_A,
      `select field_name from public.cloaked_fields where subject_id = $1`,
      [newId],
    )
    expect(rows).toEqual([{ field_name: 'title' }])
  })

  it('gives the successor the acting user as owner', async () => {
    const seriesId = await makeSeries()
    const newId = await splitFuture(seriesId)
    const { rows } = await db.as(USER_A, 'select owner_id from public.events where id = $1', [newId])
    expect(rows[0]!['owner_id']).toBe(USER_A)
  })
})

describe('this occurrence only', () => {
  const detach = async (seriesId: string, at = '2026-02-10T09:00:00') => {
    const newId = randomUUID()
    await db.as(USER_A, SPLIT, [
      seriesId,
      1,
      at,
      'this',
      newId,
      null,
      at,
      '2026-02-10T14:00:00Z',
      '2026-02-10T15:00:00Z',
      null,
      JSON.stringify([field('title', 3)]),
    ])
    return newId
  }

  it('detaches one occurrence and links the exception to its replacement', async () => {
    const seriesId = await makeSeries()
    const newId = await detach(seriesId)

    const { rows } = await db.as(
      USER_A,
      `select kind, replacement_event_id from public.recurrence_exceptions where series_id = $1`,
      [seriesId],
    )
    expect(rows).toEqual([{ kind: 'moved', replacement_event_id: newId }])
  })

  it('leaves the rule untouched and the occurrence count unchanged', async () => {
    const seriesId = await makeSeries()
    const before = (await visibleAcross(seriesId)).length

    const newId = await detach(seriesId)
    const original = await readBack(seriesId)
    expect(original.spec.rrule).toBe(SERIES_RRULE)

    // The detached occurrence leaves the series and reappears as its own row, so the total
    // the calendar renders is unchanged.
    const after = await visibleAcross(seriesId, newId)
    expect(after).toHaveLength(before)
    expect(after).toContain('2026-02-10T09:00:00')
  })

  it('still bumps the version, so a concurrent editor cannot also apply an edit', async () => {
    const seriesId = await makeSeries()
    await detach(seriesId)
    expect((await readBack(seriesId)).version).toBe(2)
  })
})

describe('refusals', () => {
  it('rejects a stale version and changes nothing', async () => {
    const seriesId = await makeSeries()
    await expect(splitFuture(seriesId, 99)).rejects.toThrow(/changed by someone else/)

    const { rows } = await db.as(USER_A, 'select count(*)::int as n from public.events')
    expect(rows[0]!['n']).toBe(1)
    expect((await readBack(seriesId)).spec.rrule).toBe(SERIES_RRULE)
  })

  it('refuses to split something that does not repeat', async () => {
    const single = await makeSeries(null)
    await expect(splitFuture(single)).rejects.toThrow(/does not repeat/)
  })

  it('refuses a future split with no replacement rule', async () => {
    const seriesId = await makeSeries()
    await expect(
      db.as(USER_A, SPLIT, [
        seriesId, 1, SPLIT_AT, 'this-and-future', randomUUID(),
        null, SPLIT_AT, '2026-03-10T13:00:00Z', '2026-03-10T14:00:00Z', SERIES_RRULE, '[]',
      ]),
    ).rejects.toThrow(/needs a replacement rule/)
  })

  it('rejects an unknown scope rather than guessing', async () => {
    const seriesId = await makeSeries()
    await expect(
      db.as(USER_A, SPLIT, [
        seriesId, 1, SPLIT_AT, 'all-of-them', randomUUID(),
        null, SPLIT_AT, '2026-03-10T13:00:00Z', '2026-03-10T14:00:00Z', null, '[]',
      ]),
    ).rejects.toThrow(/unknown split scope/)
  })

  it('rejects a wall clock carrying a timezone offset', async () => {
    // The mistake this catches is silent otherwise: Postgres drops the offset when parsing
    // into `timestamp`, so a client sending zoned.toString() would store an anchor hours off
    // with no error at all.
    const seriesId = await makeSeries()
    await expect(
      db.as(USER_A, SPLIT, [
        seriesId, 1, SPLIT_AT, 'this-and-future', randomUUID(),
        `${SERIES_RRULE};UNTIL=20260310T085959Z`,
        '2026-03-10T09:00:00-05:00',
        '2026-03-10T13:00:00Z', '2026-03-10T14:00:00Z', SERIES_RRULE, '[]',
      ]),
    ).rejects.toThrow(/not YYYY-MM-DDTHH:MM:SS/)
  })

  it('rejects content that is too short to be ciphertext, and writes nothing', async () => {
    const seriesId = await makeSeries()
    await expect(
      db.as(USER_A, SPLIT, [
        seriesId, 1, SPLIT_AT, 'this-and-future', randomUUID(),
        `${SERIES_RRULE};UNTIL=20260310T085959Z`, SPLIT_AT,
        '2026-03-10T13:00:00Z', '2026-03-10T14:00:00Z', SERIES_RRULE,
        JSON.stringify([
          { field_name: 'title', ciphertext: Buffer.from('Lunch').toString('hex'), nonce: nonce(), alg: 'aes-256-gcm-v1', key_version: 1 },
        ]),
      ]),
    ).rejects.toThrow(/too short to be AES-GCM output/)

    // One transaction: the truncation and the successor row are gone too.
    const { rows } = await db.as(USER_A, 'select count(*)::int as n from public.events')
    expect(rows[0]!['n']).toBe(1)
    expect((await readBack(seriesId)).spec.rrule).toBe(SERIES_RRULE)
  })

  it('cannot split another user series', async () => {
    const seriesId = await makeSeries()
    await expect(
      db.as(USER_B, SPLIT, [
        seriesId, 1, SPLIT_AT, 'this-and-future', randomUUID(),
        `${SERIES_RRULE};UNTIL=20260310T085959Z`, SPLIT_AT,
        '2026-03-10T13:00:00Z', '2026-03-10T14:00:00Z', SERIES_RRULE, '[]',
      ]),
    ).rejects.toThrow(/does not exist/)
    expect((await readBack(seriesId)).spec.rrule).toBe(SERIES_RRULE)
  })

  it('is not callable by an unauthenticated request', async () => {
    await expect(
      db.asUnauthenticated(SPLIT, [
        randomUUID(), 1, SPLIT_AT, 'this', randomUUID(),
        null, SPLIT_AT, '2026-03-10T13:00:00Z', '2026-03-10T14:00:00Z', null, '[]',
      ]),
    ).rejects.toThrow(/permission denied/i)
  })

  it('runs as invoker', async () => {
    const { rows } = await db.raw(
      `select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'split_cloaked_event'`,
    )
    expect(rows).toEqual([{ prosecdef: false }])
  })
})

describe('the read-back check', () => {
  it('rolls the split back when the stored rule is not the planned one', async () => {
    // Falsifiable on purpose. A trigger stands in for anything that could mutate a value
    // between intent and commit — a coercion, a constraint, a future trigger nobody has
    // written yet. Without the check the split would commit silently wrong.
    const seriesId = await makeSeries()
    // One statement per call: the harness runs these as prepared statements, which cannot
    // carry multiple commands.
    await db.raw(`create function public.mangle() returns trigger language plpgsql as $$
      begin
        if new.rrule is not null then new.rrule := new.rrule || ';INTERVAL=2'; end if;
        return new;
      end $$`)
    await db.raw(`create trigger mangle_events before insert on public.events
        for each row execute function public.mangle()`)

    try {
      await expect(splitFuture(seriesId)).rejects.toThrow(/does not match the plan/)
      const { rows } = await db.as(USER_A, 'select count(*)::int as n from public.events')
      expect(rows[0]!['n']).toBe(1)
      expect((await readBack(seriesId)).spec.rrule).toBe(SERIES_RRULE)
    } finally {
      await db.raw('drop trigger mangle_events on public.events')
      await db.raw('drop function public.mangle()')
    }
  })

  it('and passes once the trigger is gone, so the check is not simply always failing', async () => {
    const seriesId = await makeSeries()
    await expect(splitFuture(seriesId)).resolves.toBeDefined()
  })
})
