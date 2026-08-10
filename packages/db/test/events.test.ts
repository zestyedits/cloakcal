import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { cloakField, rootKeyFromSeedBytes } from '@cloakcal/crypto'
import { expandSeries } from '@cloakcal/domain'
import {
  PlaintextRejectedError,
  VerificationFailedError,
  VersionConflictError,
  applySeriesEdit,
  assertCloaked,
  createEvent,
  loadSeriesSpec,
  trashEvent,
  type Db,
} from '../src/events.js'
import { createTestDb, USER_A, USER_B, type TestDb } from './harness.js'

/**
 * Service-level gates for event CRUD.
 *
 * The domain tests prove the plan is correct. These prove the plan is APPLIED correctly —
 * a different question. A split that is right in the abstract can still be persisted
 * wrongly: half-written, applied to a stale version, or landing rows in the wrong
 * workspace. Each gate below targets one of those failure modes.
 */

let db: TestDb
let wsA: string
let calA: string
let wsB: string
let calB: string

const KEY = rootKeyFromSeedBytes(new Uint8Array(32).fill(11))

const field = async (eventIdOrNull: string, name: string, value: string) => ({
  fieldName: name,
  payload: await cloakField(KEY, { type: 'event', id: eventIdOrNull }, name, value),
})

/** Payload bound to a placeholder subject — fine where the test never decrypts it. */
const anyField = (name: string, value: string) =>
  field('00000000-0000-4000-8000-000000000001', name, value)

const dbFor = (user: string): Db => ({
  query: (sql, params) => db.as(user, sql, params),
  transaction: (fn) => db.asTransaction(user, fn),
})

const VERIFY_RANGE = { from: '2026-01-01T00:00:00Z', to: '2026-12-31T00:00:00Z' }

const makeSeries = async (user: string, ws: string, cal: string) =>
  createEvent(dbFor(user), {
    workspaceId: ws,
    calendarId: cal,
    ownerId: user,
    startUtc: '2026-01-06T14:00:00Z',
    endUtc: '2026-01-06T15:00:00Z',
    timezone: 'America/New_York',
    rrule: 'FREQ=WEEKLY;BYDAY=TU',
    dtstartLocal: '2026-01-06 09:00:00',
    fields: [await anyField('title', 'Weekly Sync')],
  })

beforeEach(async () => {
  db = await createTestDb()
  await db.createUser(USER_A, 'a@example.test')
  await db.createUser(USER_B, 'b@example.test')

  const mk = async (user: string) => {
    const ws = await db.as(user, `insert into public.workspaces (owner_id) values ($1) returning id`, [user])
    const wsId = ws.rows[0]!['id'] as string
    const cal = await db.as(
      user,
      `insert into public.calendars (workspace_id, is_default) values ($1, true) returning id`,
      [wsId],
    )
    return [wsId, cal.rows[0]!['id'] as string] as const
  }
  ;[wsA, calA] = await mk(USER_A)
  ;[wsB, calB] = await mk(USER_B)
})

afterEach(async () => {
  await db.close()
})

/* -------------------------------------------------------------------------- */

describe('gate 4: plaintext never crosses the boundary', () => {
  it('rejects a value that is too short to be AES-GCM output', async () => {
    // 'Legal Call' as bytes is 10 bytes. Real ciphertext is >= 16 because of the tag.
    expect(() =>
      assertCloaked({
        fieldName: 'title',
        payload: {
          ciphertext: new Uint8Array(Buffer.from('Legal Call', 'utf8')),
          nonce: new Uint8Array(12),
          alg: 'aes-256-gcm-v1',
          keyVersion: 1,
        },
      }),
    ).toThrow(PlaintextRejectedError)
  })

  it('names plaintext as the likely cause, so the error is actionable', () => {
    expect(() =>
      assertCloaked({
        fieldName: 'title',
        payload: {
          ciphertext: new Uint8Array(4),
          nonce: new Uint8Array(12),
          alg: 'aes-256-gcm-v1',
          keyVersion: 1,
        },
      }),
    ).toThrow(/looks like plaintext/)
  })

  it('rejects a foreign algorithm', async () => {
    const f = await anyField('title', 'Weekly Sync')
    expect(() =>
      assertCloaked({ ...f, payload: { ...f.payload, alg: 'plaintext-v0' as never } }),
    ).toThrow(/only aes-256-gcm-v1/)
  })

  it('rejects a wrong-sized nonce', async () => {
    const f = await anyField('title', 'Weekly Sync')
    expect(() =>
      assertCloaked({ ...f, payload: { ...f.payload, nonce: new Uint8Array(8) } }),
    ).toThrow(/AES-GCM requires 12/)
  })

  it('accepts genuine ciphertext', async () => {
    const good = await anyField('title', 'x')
    expect(() => assertCloaked(good)).not.toThrow()
    expect(good.payload.ciphertext.length).toBeGreaterThanOrEqual(16)
  })

  it('refuses to begin a write when any field is bad', async () => {
    const before = await db.as(USER_A, 'select count(*)::int as n from public.events')

    await expect(
      createEvent(dbFor(USER_A), {
        workspaceId: wsA,
        calendarId: calA,
        ownerId: USER_A,
        startUtc: '2026-01-06T14:00:00Z',
        endUtc: '2026-01-06T15:00:00Z',
        timezone: 'UTC',
        fields: [
          await anyField('title', 'fine'),
          { fieldName: 'notes', payload: { ciphertext: new Uint8Array(3), nonce: new Uint8Array(12), alg: 'aes-256-gcm-v1', keyVersion: 1 } },
        ],
      }),
    ).rejects.toThrow(PlaintextRejectedError)

    // Validation happens before the transaction opens: nothing was written at all.
    const after = await db.as(USER_A, 'select count(*)::int as n from public.events')
    expect(after.rows[0]!['n']).toBe(before.rows[0]!['n'])
  })

  it('stores only ciphertext, never a readable title', async () => {
    const eventId = await makeSeries(USER_A, wsA, calA)
    const { rows } = await db.as(
      USER_A,
      `select encode(ciphertext,'escape') as raw, alg from public.cloaked_fields where subject_id = $1`,
      [eventId],
    )
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r['alg']).toBe('aes-256-gcm-v1')
      expect(String(r['raw'])).not.toContain('Weekly Sync')
    }
  })
})

/* -------------------------------------------------------------------------- */

describe('gate 1 + 3: a split is atomic and verified against what was stored', () => {
  it('persists truncation and successor together', async () => {
    const seriesId = await makeSeries(USER_A, wsA, calA)

    const result = await applySeriesEdit(dbFor(USER_A), {
      seriesId,
      workspaceId: wsA,
      actorId: USER_A,
      occurrenceLocal: '2026-03-10T09:00:00',
      scope: 'this-and-future',
      expectedVersion: 1,
      fields: [await anyField('title', 'Weekly Sync v2')],
      verifyRange: VERIFY_RANGE,
    })

    expect(result.truncatedSeriesId).toBe(seriesId)
    expect(result.successorSeriesId).toBeTruthy()

    const { rows } = await db.as(USER_A, 'select count(*)::int as n from public.events')
    expect(rows[0]!['n']).toBe(2)
  })

  it('reproduces the original occurrence set from the STORED series', async () => {
    // Gate 3: not "the plan was right" but "what actually landed in the database is right".
    const seriesId = await makeSeries(USER_A, wsA, calA)
    const original = expandSeries((await loadSeriesSpec(dbFor(USER_A).query, seriesId))!, VERIFY_RANGE)

    const result = await applySeriesEdit(dbFor(USER_A), {
      seriesId,
      workspaceId: wsA,
      actorId: USER_A,
      occurrenceLocal: '2026-03-10T09:00:00',
      scope: 'this-and-future',
      expectedVersion: 1,
      fields: [await anyField('title', 'v2')],
      verifyRange: VERIFY_RANGE,
    })

    const storedOriginal = (await loadSeriesSpec(dbFor(USER_A).query, seriesId))!
    const storedSuccessor = (await loadSeriesSpec(dbFor(USER_A).query, result.successorSeriesId!))!

    const rejoined = [
      ...expandSeries(storedOriginal, VERIFY_RANGE),
      ...expandSeries(storedSuccessor, VERIFY_RANGE),
    ].map((o) => o.occurrenceLocal)

    expect(rejoined).toEqual(original.map((o) => o.occurrenceLocal))
  })

  it('puts nothing at or after the split in the truncated series', async () => {
    const seriesId = await makeSeries(USER_A, wsA, calA)
    const splitAt = '2026-03-10T09:00:00'

    const result = await applySeriesEdit(dbFor(USER_A), {
      seriesId, workspaceId: wsA, actorId: USER_A, occurrenceLocal: splitAt,
      scope: 'this-and-future', expectedVersion: 1,
      fields: [await anyField('title', 'v2')], verifyRange: VERIFY_RANGE,
    })

    const before = expandSeries((await loadSeriesSpec(dbFor(USER_A).query, seriesId))!, VERIFY_RANGE)
    const after = expandSeries(
      (await loadSeriesSpec(dbFor(USER_A).query, result.successorSeriesId!))!,
      VERIFY_RANGE,
    )

    expect(before.every((o) => o.occurrenceLocal < splitAt)).toBe(true)
    expect(after.every((o) => o.occurrenceLocal >= splitAt)).toBe(true)
  })

  it('writes an audit entry naming the scope, with no content in it', async () => {
    const seriesId = await makeSeries(USER_A, wsA, calA)
    await applySeriesEdit(dbFor(USER_A), {
      seriesId, workspaceId: wsA, actorId: USER_A, occurrenceLocal: '2026-03-10T09:00:00',
      scope: 'this-and-future', expectedVersion: 1,
      fields: [await anyField('title', 'Weekly Sync v2')], verifyRange: VERIFY_RANGE,
    })

    const { rows } = await db.as(USER_A, `select action, detail from public.audit_log order by id`)
    const actions = rows.map((r) => r['action'])
    expect(actions).toContain('event.edit.this-and-future')
    expect(JSON.stringify(rows)).not.toContain('Weekly Sync')
  })

  it('detaches a single occurrence and links the exception to its replacement', async () => {
    const seriesId = await makeSeries(USER_A, wsA, calA)

    const result = await applySeriesEdit(dbFor(USER_A), {
      seriesId, workspaceId: wsA, actorId: USER_A, occurrenceLocal: '2026-02-10T09:00:00',
      scope: 'this', expectedVersion: 1, fields: [await anyField('title', 'Moved one')],
    })

    expect(result.detachedEventId).toBeTruthy()
    const { rows } = await db.as(
      USER_A,
      `select kind, replacement_event_id from public.recurrence_exceptions where series_id = $1`,
      [seriesId],
    )
    expect(rows[0]!['kind']).toBe('moved')
    expect(rows[0]!['replacement_event_id']).toBe(result.detachedEventId)
  })

  it('accepts a split on a non-occurrence date that is still lossless', async () => {
    // Worth pinning: splitting a Tuesday series on a Wednesday is harmless. The successor
    // carries BYDAY=TU, so its first occurrence is the following Tuesday and the union is
    // unchanged. Gate 3 checks the OCCURRENCE SET, not whether the split point was itself
    // an occurrence — so this must pass, and a stricter check here would be wrong.
    const seriesId = await makeSeries(USER_A, wsA, calA)
    const original = expandSeries((await loadSeriesSpec(dbFor(USER_A).query, seriesId))!, VERIFY_RANGE)

    const result = await applySeriesEdit(dbFor(USER_A), {
      seriesId, workspaceId: wsA, actorId: USER_A,
      occurrenceLocal: '2026-03-11T09:00:00', // a Wednesday; the series is Tuesdays
      scope: 'this-and-future', expectedVersion: 1,
      fields: [await anyField('title', 'v2')], verifyRange: VERIFY_RANGE,
    })

    const rejoined = [
      ...expandSeries((await loadSeriesSpec(dbFor(USER_A).query, seriesId))!, VERIFY_RANGE),
      ...expandSeries((await loadSeriesSpec(dbFor(USER_A).query, result.successorSeriesId!))!, VERIFY_RANGE),
    ].map((o) => o.occurrenceLocal)
    expect(rejoined).toEqual(original.map((o) => o.occurrenceLocal))
  })

  it('rolls back everything when verification fails', async () => {
    const seriesId = await makeSeries(USER_A, wsA, calA)

    // A split point at the wrong TIME OF DAY genuinely diverges: the successor would
    // generate Tuesdays at 10:00 while the original generated them at 09:00, so the
    // rejoined set no longer matches. Gate 3 must reject and unwind the whole transaction.
    await expect(
      applySeriesEdit(dbFor(USER_A), {
        seriesId, workspaceId: wsA, actorId: USER_A,
        occurrenceLocal: '2026-03-10T10:00:00', // right weekday, wrong hour
        scope: 'this-and-future', expectedVersion: 1,
        fields: [await anyField('title', 'v2')], verifyRange: VERIFY_RANGE,
      }),
    ).rejects.toThrow(VerificationFailedError)

    const events = await db.as(USER_A, 'select id, rrule, version from public.events')
    expect(events.rows).toHaveLength(1)
    expect(events.rows[0]!['rrule']).toBe('FREQ=WEEKLY;BYDAY=TU')
    expect(events.rows[0]!['version']).toBe(1)
  })
})

/* -------------------------------------------------------------------------- */

describe('gate 2: optimistic concurrency', () => {
  it('rejects an edit based on a stale version', async () => {
    const seriesId = await makeSeries(USER_A, wsA, calA)

    await applySeriesEdit(dbFor(USER_A), {
      seriesId, workspaceId: wsA, actorId: USER_A, occurrenceLocal: '2026-03-10T09:00:00',
      scope: 'this-and-future', expectedVersion: 1,
      fields: [await anyField('title', 'v2')], verifyRange: VERIFY_RANGE,
    })

    // A second editor still holding version 1 must not be able to split again.
    await expect(
      applySeriesEdit(dbFor(USER_A), {
        seriesId, workspaceId: wsA, actorId: USER_A, occurrenceLocal: '2026-02-10T09:00:00',
        scope: 'this-and-future', expectedVersion: 1,
        fields: [await anyField('title', 'v3')], verifyRange: VERIFY_RANGE,
      }),
    ).rejects.toThrow(VersionConflictError)
  })

  it('leaves no partial successor behind after a conflict', async () => {
    const seriesId = await makeSeries(USER_A, wsA, calA)
    await applySeriesEdit(dbFor(USER_A), {
      seriesId, workspaceId: wsA, actorId: USER_A, occurrenceLocal: '2026-03-10T09:00:00',
      scope: 'this-and-future', expectedVersion: 1,
      fields: [await anyField('title', 'v2')], verifyRange: VERIFY_RANGE,
    })
    const countAfterFirst = await db.as(USER_A, 'select count(*)::int as n from public.events')

    await expect(
      applySeriesEdit(dbFor(USER_A), {
        seriesId, workspaceId: wsA, actorId: USER_A, occurrenceLocal: '2026-02-10T09:00:00',
        scope: 'this-and-future', expectedVersion: 1,
        fields: [await anyField('title', 'v3')], verifyRange: VERIFY_RANGE,
      }),
    ).rejects.toThrow(VersionConflictError)

    const countAfterConflict = await db.as(USER_A, 'select count(*)::int as n from public.events')
    expect(countAfterConflict.rows[0]!['n']).toBe(countAfterFirst.rows[0]!['n'])
  })

  it('bumps the version on every applied edit', async () => {
    const seriesId = await makeSeries(USER_A, wsA, calA)
    expect((await loadSeriesSpec(dbFor(USER_A).query, seriesId))!.version).toBe(1)

    await applySeriesEdit(dbFor(USER_A), {
      seriesId, workspaceId: wsA, actorId: USER_A, occurrenceLocal: '2026-02-10T09:00:00',
      scope: 'this', expectedVersion: 1, fields: [await anyField('title', 'one-off')],
    })
    expect((await loadSeriesSpec(dbFor(USER_A).query, seriesId))!.version).toBe(2)
  })

  it('guards trash with the same version check', async () => {
    const seriesId = await makeSeries(USER_A, wsA, calA)
    await expect(
      trashEvent(dbFor(USER_A), { eventId: seriesId, workspaceId: wsA, actorId: USER_A, expectedVersion: 99 }),
    ).rejects.toThrow(VersionConflictError)

    await trashEvent(dbFor(USER_A), { eventId: seriesId, workspaceId: wsA, actorId: USER_A, expectedVersion: 1 })
    const { rows } = await db.as(USER_A, 'select lifecycle from public.events where id = $1', [seriesId])
    expect(rows[0]!['lifecycle']).toBe('trashed')
  })
})

/* -------------------------------------------------------------------------- */

describe('gate 5: cross-workspace CRUD is denied and rolls back cleanly', () => {
  it('lets user B create freely in their OWN workspace', async () => {
    // Positive control. Without it, every denial below could be passing simply because
    // user B is unable to write anywhere — which would make the gate meaningless.
    const id = await createEvent(dbFor(USER_B), {
      workspaceId: wsB,
      calendarId: calB,
      ownerId: USER_B,
      startUtc: '2026-01-06T14:00:00Z',
      endUtc: '2026-01-06T15:00:00Z',
      timezone: 'UTC',
      fields: [await anyField('title', 'B own event')],
    })
    expect(id).toBeTruthy()

    const { rows } = await db.as(USER_B, 'select id from public.events')
    expect(rows.map((r) => r['id'])).toEqual([id])
  })

  it('refuses to create an event in another user workspace', async () => {
    await expect(
      createEvent(dbFor(USER_B), {
        workspaceId: wsA,
        calendarId: calA,
        ownerId: USER_B,
        startUtc: '2026-01-06T14:00:00Z',
        endUtc: '2026-01-06T15:00:00Z',
        timezone: 'UTC',
        fields: [await anyField('title', 'intrusion')],
      }),
    ).rejects.toThrow(/row-level security/i)
  })

  it('leaves no orphaned cloaked_fields behind after a denied create', async () => {
    // The partial-write case that matters: the event insert fails, but a field row could
    // survive if the write were not transactional.
    const before = await db.as(USER_A, 'select count(*)::int as n from public.cloaked_fields')

    await expect(
      createEvent(dbFor(USER_B), {
        workspaceId: wsA, calendarId: calA, ownerId: USER_B,
        startUtc: '2026-01-06T14:00:00Z', endUtc: '2026-01-06T15:00:00Z', timezone: 'UTC',
        fields: [await anyField('title', 'intrusion')],
      }),
    ).rejects.toThrow()

    const after = await db.as(USER_A, 'select count(*)::int as n from public.cloaked_fields')
    expect(after.rows[0]!['n']).toBe(before.rows[0]!['n'])
  })

  it('cannot split another user series', async () => {
    const seriesId = await makeSeries(USER_A, wsA, calA)

    await expect(
      applySeriesEdit(dbFor(USER_B), {
        seriesId, workspaceId: wsB, actorId: USER_B, occurrenceLocal: '2026-03-10T09:00:00',
        scope: 'this-and-future', expectedVersion: 1,
        fields: [await anyField('title', 'hijack')], verifyRange: VERIFY_RANGE,
      }),
    ).rejects.toThrow()

    const events = await db.as(USER_A, 'select rrule, version from public.events')
    expect(events.rows).toHaveLength(1)
    expect(events.rows[0]!['rrule']).toBe('FREQ=WEEKLY;BYDAY=TU')
    expect(events.rows[0]!['version']).toBe(1)
  })

  it('cannot file a cloaked field against a subject in another workspace', async () => {
    const seriesId = await makeSeries(USER_A, wsA, calA)
    const f = await anyField('notes', 'leak attempt')

    await expect(
      db.as(
        USER_B,
        `insert into public.cloaked_fields
           (subject_type, subject_id, workspace_id, field_name, ciphertext, nonce, alg)
         values ('event', $1, $2, 'notes', $3, $4, 'aes-256-gcm-v1')`,
        [seriesId, wsB, f.payload.ciphertext, f.payload.nonce],
      ),
    ).rejects.toThrow(/does not belong to workspace/)
  })

  it('keeps user B unable to see anything user A created', async () => {
    await makeSeries(USER_A, wsA, calA)
    const events = await db.as(USER_B, 'select id from public.events')
    const fields = await db.as(USER_B, 'select id from public.cloaked_fields')
    const exceptions = await db.as(USER_B, 'select id from public.recurrence_exceptions')
    expect(events.rows).toHaveLength(0)
    expect(fields.rows).toHaveLength(0)
    expect(exceptions.rows).toHaveLength(0)
  })
})

/* -------------------------------------------------------------------------- */

describe('round-tripping stored state through the domain', () => {
  it('reads dtstart_local back as the same wall clock it was written with', async () => {
    const seriesId = await makeSeries(USER_A, wsA, calA)
    const spec = (await loadSeriesSpec(dbFor(USER_A).query, seriesId))!
    expect(spec.dtstartLocal).toBe('2026-01-06T09:00:00')
    expect(spec.timezone).toBe('America/New_York')
    expect(spec.durationMinutes).toBe(60)
  })

  it('expands the stored series to the same wall clock all year', async () => {
    const seriesId = await makeSeries(USER_A, wsA, calA)
    const occurrences = expandSeries((await loadSeriesSpec(dbFor(USER_A).query, seriesId))!, VERIFY_RANGE)
    expect(occurrences.length).toBeGreaterThan(45)
    for (const o of occurrences) expect(o.start.slice(11, 16)).toBe('09:00')
  })
})
