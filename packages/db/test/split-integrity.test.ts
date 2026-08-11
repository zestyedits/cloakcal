import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloakField, rootKeyFromSeedBytes, uncloakField } from '@cloakcal/crypto'
import { expandSeries, type ExceptionSpec, type SeriesSpec } from '@cloakcal/domain'
import { applySeriesEdit, createEvent, loadSeriesSpec, type Db } from '../src/events.js'
import { createTestDb, USER_A, USER_B, type TestDb } from './harness.js'

/**
 * Three defects a split used to have, each of which produced a WRONG CALENDAR rather than an
 * error. None was caught by the existing suite, and the reason is the same in all three
 * cases: the tests asserted on the shape of what was written instead of on what a reader
 * would afterwards see.
 *
 *   1. Successor content could never be decrypted. The new event's id came from Postgres,
 *      but the caller had already sealed its fields — and the AEAD binds ciphertext to the
 *      subject id. Invisible because no test ever decrypted.
 *   2. Cancelled future occurrences came back. Exception rows stayed pointed at the original
 *      series after the split, so the successor never saw them. Invisible because no test
 *      expanded the two halves WITH their exceptions.
 *   3. New rows copied the original's owner instead of the editor. Invisible because every
 *      test workspace has exactly one member, so the two are always the same person.
 *
 * Each test below observes the defect the way the product would: decrypt the content, expand
 * the series, or write as somebody else.
 */

const KEY = rootKeyFromSeedBytes(new Uint8Array(32).fill(11))

let db: TestDb
let wsA: string
let calA: string

const dbFor = (user: string): Db => ({
  query: (sql, params) => db.as(user, sql, params),
  transaction: (fn) => db.asTransaction(user, fn),
})

/** Seal against a specific event id — the whole point of these tests. */
const sealedFor = async (eventId: string, name: string, value: string) => ({
  fieldName: name,
  payload: await cloakField(KEY, { type: 'event', id: eventId }, name, value),
})

const RANGE = { from: '2026-01-01T00:00:00Z', to: '2026-12-31T00:00:00Z' }
const SPLIT_AT = '2026-03-10T09:00:00'

const makeSeries = async (owner: string, workspaceId: string, calendarId: string) => {
  const id = randomUUID()
  await createEvent(dbFor(owner), {
    workspaceId,
    calendarId,
    ownerId: owner,
    startUtc: '2026-01-06T14:00:00Z',
    endUtc: '2026-01-06T15:00:00Z',
    timezone: 'America/New_York',
    rrule: 'FREQ=WEEKLY;BYDAY=TU',
    dtstartLocal: '2026-01-06 09:00:00',
    fields: [await sealedFor(id, 'title', 'placeholder')],
  })
  // createEvent lets Postgres assign the id, so read it back. The RPCs the browser uses take
  // a caller-supplied id; this helper only needs a series to split.
  const { rows } = await db.as(owner, 'select id from public.events order by created_at desc limit 1')
  return rows[0]!['id'] as string
}

/** Read a series and its exceptions back the way the read path does. */
const readBack = async (
  user: string,
  seriesId: string,
): Promise<{ spec: SeriesSpec; exceptions: ExceptionSpec[] }> => {
  const spec = await loadSeriesSpec(dbFor(user).query, seriesId)
  const { rows } = await db.as(
    user,
    `select to_char(occurrence_local, 'YYYY-MM-DD"T"HH24:MI:SS') as local, kind
       from public.recurrence_exceptions where series_id = $1`,
    [seriesId],
  )
  return {
    spec: spec!,
    exceptions: rows.map((r) => ({
      occurrenceLocal: String(r['local']),
      kind: r['kind'] as ExceptionSpec['kind'],
    })),
  }
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

describe('a split writes content the owner can actually read back', () => {
  it('decrypts the successor title', async () => {
    const seriesId = await makeSeries(USER_A, wsA, calA)
    const successorId = randomUUID()

    // The caller generates the id, seals against it, and hands both over. This is the only
    // order that can work: the AAD binds the ciphertext to the id, so the id must come first.
    await applySeriesEdit(dbFor(USER_A), {
      seriesId,
      workspaceId: wsA,
      actorId: USER_A,
      occurrenceLocal: SPLIT_AT,
      scope: 'this-and-future',
      newEventId: successorId,
      expectedVersion: 1,
      fields: [await sealedFor(successorId, 'title', 'Weekly Sync, revised')],
      verifyRange: RANGE,
    })

    const { rows } = await db.as(
      USER_A,
      `select ciphertext, nonce, alg, key_version from public.cloaked_fields
        where subject_id = $1 and field_name = 'title'`,
      [successorId],
    )
    expect(rows).toHaveLength(1)

    // The assertion that matters. Before the fix this threw, because the row had been filed
    // against a Postgres-generated id the caller never saw.
    const title = await uncloakField(
      KEY,
      { type: 'event', id: successorId },
      'title',
      {
        ciphertext: new Uint8Array(rows[0]!['ciphertext'] as Uint8Array),
        nonce: new Uint8Array(rows[0]!['nonce'] as Uint8Array),
        alg: 'aes-256-gcm-v1',
        keyVersion: Number(rows[0]!['key_version']),
      },
    )
    expect(title).toBe('Weekly Sync, revised')
  })

  it('decrypts a detached occurrence title', async () => {
    const seriesId = await makeSeries(USER_A, wsA, calA)
    const detachedId = randomUUID()

    await applySeriesEdit(dbFor(USER_A), {
      seriesId,
      workspaceId: wsA,
      actorId: USER_A,
      occurrenceLocal: '2026-02-10T09:00:00',
      scope: 'this',
      newEventId: detachedId,
      expectedVersion: 1,
      fields: [await sealedFor(detachedId, 'title', 'Just this once')],
    })

    const { rows } = await db.as(
      USER_A,
      `select ciphertext, nonce, key_version from public.cloaked_fields
        where subject_id = $1 and field_name = 'title'`,
      [detachedId],
    )
    const title = await uncloakField(KEY, { type: 'event', id: detachedId }, 'title', {
      ciphertext: new Uint8Array(rows[0]!['ciphertext'] as Uint8Array),
      nonce: new Uint8Array(rows[0]!['nonce'] as Uint8Array),
      alg: 'aes-256-gcm-v1',
      keyVersion: Number(rows[0]!['key_version']),
    })
    expect(title).toBe('Just this once')
  })

  it('refuses content sealed against the wrong id, proving the binding is real', async () => {
    // Without this, the two tests above could pass for reasons unrelated to the binding.
    const seriesId = await makeSeries(USER_A, wsA, calA)
    const successorId = randomUUID()
    const strangerId = randomUUID()

    await applySeriesEdit(dbFor(USER_A), {
      seriesId,
      workspaceId: wsA,
      actorId: USER_A,
      occurrenceLocal: SPLIT_AT,
      scope: 'this-and-future',
      newEventId: successorId,
      expectedVersion: 1,
      // Deliberately sealed against a DIFFERENT id — exactly what the old code produced.
      fields: [await sealedFor(strangerId, 'title', 'unreadable')],
      verifyRange: RANGE,
    })

    const { rows } = await db.as(
      USER_A,
      `select ciphertext, nonce, key_version from public.cloaked_fields
        where subject_id = $1 and field_name = 'title'`,
      [successorId],
    )
    await expect(
      uncloakField(KEY, { type: 'event', id: successorId }, 'title', {
        ciphertext: new Uint8Array(rows[0]!['ciphertext'] as Uint8Array),
        nonce: new Uint8Array(rows[0]!['nonce'] as Uint8Array),
        alg: 'aes-256-gcm-v1',
        keyVersion: Number(rows[0]!['key_version']),
      }),
    ).rejects.toThrow()
  })
})

describe('a split carries future cancellations across to the successor', () => {
  it('keeps a cancelled future occurrence cancelled', async () => {
    const seriesId = await makeSeries(USER_A, wsA, calA)

    // 2026-03-17 is a Tuesday one week AFTER the split point, so it belongs to the successor.
    const cancelled = '2026-03-17T09:00:00'
    await db.as(
      USER_A,
      `insert into public.recurrence_exceptions (series_id, workspace_id, occurrence_local, kind)
       values ($1, $2, $3, 'cancelled')`,
      [seriesId, wsA, cancelled.replace('T', ' ')],
    )

    const successorId = randomUUID()
    await applySeriesEdit(dbFor(USER_A), {
      seriesId,
      workspaceId: wsA,
      actorId: USER_A,
      occurrenceLocal: SPLIT_AT,
      scope: 'this-and-future',
      newEventId: successorId,
      expectedVersion: 1,
      fields: [await sealedFor(successorId, 'title', 'v2')],
      verifyRange: RANGE,
    })

    // Observed through expansion, not by inspecting series_id. A row pointing at the right
    // series proves nothing if the reader still renders the occurrence.
    const original = await readBack(USER_A, seriesId)
    const successor = await readBack(USER_A, successorId)
    const visible = [
      ...expandSeries(original.spec, RANGE, original.exceptions),
      ...expandSeries(successor.spec, RANGE, successor.exceptions),
    ].map((o) => o.occurrenceLocal)

    expect(visible).not.toContain(cancelled)
  })

  it('leaves a cancellation before the split with the original series', async () => {
    const seriesId = await makeSeries(USER_A, wsA, calA)

    const cancelled = '2026-02-03T09:00:00'
    await db.as(
      USER_A,
      `insert into public.recurrence_exceptions (series_id, workspace_id, occurrence_local, kind)
       values ($1, $2, $3, 'cancelled')`,
      [seriesId, wsA, cancelled.replace('T', ' ')],
    )

    const successorId = randomUUID()
    await applySeriesEdit(dbFor(USER_A), {
      seriesId,
      workspaceId: wsA,
      actorId: USER_A,
      occurrenceLocal: SPLIT_AT,
      scope: 'this-and-future',
      newEventId: successorId,
      expectedVersion: 1,
      fields: [await sealedFor(successorId, 'title', 'v2')],
      verifyRange: RANGE,
    })

    const original = await readBack(USER_A, seriesId)
    const successor = await readBack(USER_A, successorId)

    expect(original.exceptions.map((e) => e.occurrenceLocal)).toEqual([cancelled])
    expect(successor.exceptions).toEqual([])

    const visible = [
      ...expandSeries(original.spec, RANGE, original.exceptions),
      ...expandSeries(successor.spec, RANGE, successor.exceptions),
    ].map((o) => o.occurrenceLocal)
    expect(visible).not.toContain(cancelled)
  })

  it('is not vacuous — an uncancelled Tuesday after the split is still there', async () => {
    // If the split simply lost every future occurrence, both tests above would pass.
    const seriesId = await makeSeries(USER_A, wsA, calA)
    const successorId = randomUUID()

    await applySeriesEdit(dbFor(USER_A), {
      seriesId,
      workspaceId: wsA,
      actorId: USER_A,
      occurrenceLocal: SPLIT_AT,
      scope: 'this-and-future',
      newEventId: successorId,
      expectedVersion: 1,
      fields: [await sealedFor(successorId, 'title', 'v2')],
      verifyRange: RANGE,
    })

    const successor = await readBack(USER_A, successorId)
    const visible = expandSeries(successor.spec, RANGE, successor.exceptions).map(
      (o) => o.occurrenceLocal,
    )
    expect(visible).toContain('2026-03-17T09:00:00')
  })
})

describe('new rows belong to the editor', () => {
  it('gives the successor the acting user as owner', async () => {
    const seriesId = await makeSeries(USER_A, wsA, calA)
    const successorId = randomUUID()

    await applySeriesEdit(dbFor(USER_A), {
      seriesId,
      workspaceId: wsA,
      actorId: USER_A,
      occurrenceLocal: SPLIT_AT,
      scope: 'this-and-future',
      newEventId: successorId,
      expectedVersion: 1,
      fields: [await sealedFor(successorId, 'title', 'v2')],
      verifyRange: RANGE,
    })

    const { rows } = await db.as(USER_A, 'select owner_id from public.events where id = $1', [
      successorId,
    ])
    expect(rows[0]!['owner_id']).toBe(USER_A)
  })

  /**
   * Weak on its own — every workspace has one member today, so the actor and the original
   * owner are always the same person and copying would pass too. It is here because the
   * column is now pinned to `actorId` rather than to "whatever the original had", and the
   * test below records why that had to change.
   */
  it('cannot edit an event owned by someone else, even inside your own workspace', async () => {
    // Seeded as superuser: RLS would refuse this write through the normal path, which is the
    // point. The row exists in USER_A's workspace but belongs to USER_B.
    const seriesId = randomUUID()
    await db.raw(
      `insert into public.events
         (id, workspace_id, calendar_id, owner_id, start_utc, end_utc, timezone, rrule, dtstart_local)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        seriesId,
        wsA,
        calA,
        USER_B,
        '2026-01-06T14:00:00Z',
        '2026-01-06T15:00:00Z',
        'America/New_York',
        'FREQ=WEEKLY;BYDAY=TU',
        '2026-01-06 09:00:00',
      ],
    )

    // USER_A owns the workspace, so `using (is_workspace_member(...))` lets them SEE it.
    const visible = await db.as(USER_A, 'select id from public.events where id = $1', [seriesId])
    expect(visible.rows).toHaveLength(1)

    // But `events_all` also carries `with check (... and owner_id = auth.uid())`, and WITH
    // CHECK applies to the row as it will be AFTER an update. Truncating the series leaves
    // owner_id as USER_B, so the very first write of the split is refused.
    //
    // Worth stating plainly because it is a product constraint, not a bug: under today's
    // policy a workspace co-member can read a colleague's event and cannot change it at all.
    // That is the right default while teams are deferred, and it is the thing to revisit
    // deliberately when they land — not to discover then.
    await expect(
      applySeriesEdit(dbFor(USER_A), {
        seriesId,
        workspaceId: wsA,
        actorId: USER_A,
        occurrenceLocal: SPLIT_AT,
        scope: 'this-and-future',
        newEventId: randomUUID(),
        expectedVersion: 1,
        fields: [await sealedFor(randomUUID(), 'title', 'v2')],
        verifyRange: RANGE,
      }),
    ).rejects.toThrow(/row-level security/i)

    // And it rolled back cleanly: still one event, still untruncated.
    const after = await db.as(USER_A, 'select rrule from public.events where workspace_id = $1', [wsA])
    expect(after.rows).toEqual([{ rrule: 'FREQ=WEEKLY;BYDAY=TU' }])
  })
})
