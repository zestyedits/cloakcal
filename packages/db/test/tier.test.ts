import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { createTestDb, USER_A, type TestDb } from './harness.js'

/**
 * Tier discipline (plan §4).
 *
 * The data classification matrix is only worth having if something enforces it. The risk
 * is not malice, it is drift: someone adds `events.title text` during a hurried feature
 * and Tier B content quietly becomes server-readable forever. These tests make that a red
 * CI run instead of a discovery six months later.
 */

let db: TestDb
let wsA: string
let calA: string

/**
 * Every column permitted on `events`. Adding one here is a deliberate act that says "this
 * is operational metadata the server must process" — exactly the decision the matrix
 * requires someone to make consciously.
 */
const EVENTS_TIER_A_COLUMNS = new Set([
  'id',
  'workspace_id',
  'calendar_id',
  'owner_id',
  'start_utc',
  'end_utc',
  'timezone',
  'all_day',
  'start_date',
  'end_date',
  'rrule',
  'dtstart_local',
  'recurrence_parent_id',
  'recurrence_instance_start',
  'busy',
  'reminder_offsets',
  'lifecycle',
  'trashed_at',
  'version',
  'created_at',
  'updated_at',
])

const TIER_B_NAMES = [
  'title',
  'summary',
  'description',
  'notes',
  'location',
  'attendees',
  'attendee_emails',
  'video_link',
  'meeting_url',
  'attachments',
  'display_name',
  'name',
  'slug',
]

const TIER_A_TABLES = [
  'workspaces',
  'calendars',
  'events',
  'recurrence_exceptions',
  'visibility_rules',
  'presets',
  'devices',
  'access_envelopes',
  'applied_ops',
  'audit_log',
]

beforeAll(async () => {
  db = await createTestDb()
  await db.createUser(USER_A, 'a@example.test')

  const ws = await db.as(USER_A, `insert into public.workspaces (owner_id) values ($1) returning id`, [
    USER_A,
  ])
  wsA = ws.rows[0]!['id'] as string

  const cal = await db.as(
    USER_A,
    `insert into public.calendars (workspace_id, is_default) values ($1, true) returning id`,
    [wsA],
  )
  calA = cal.rows[0]!['id'] as string
})

afterAll(async () => {
  await db.close()
})

const columnsOf = async (table: string) => {
  const { rows } = await db.raw(
    `select column_name, data_type, is_nullable from information_schema.columns
     where table_schema = 'public' and table_name = $1`,
    [table],
  )
  return rows
}

describe('Tier A tables carry no Tier B content', () => {
  it('events exposes exactly the approved operational columns', async () => {
    const actual = new Set((await columnsOf('events')).map((r) => r['column_name'] as string))
    expect([...actual].sort()).toEqual([...EVENTS_TIER_A_COLUMNS].sort())
  })

  it('no longer carries a sensitivity flag', async () => {
    // is_cloaked told the server which events the user considers sensitive — the single
    // most revealing bit in the schema. Removed at M0 review; notifications now default
    // to safe wording for every event instead.
    const names = (await columnsOf('events')).map((r) => r['column_name'])
    expect(names).not.toContain('is_cloaked')
  })

  it.each(TIER_A_TABLES)('%s has no column named after a Cloaked field', async (table) => {
    const names = (await columnsOf(table)).map((r) => r['column_name'] as string)
    expect(names.filter((n) => TIER_B_NAMES.includes(n))).toEqual([])
  })

  it('routes workspaces by an opaque token, not a readable slug', async () => {
    const names = (await columnsOf('workspaces')).map((r) => r['column_name'])
    expect(names).toContain('route_token')
    expect(names).not.toContain('slug')
  })

  it('defaults calendar export to none, so nothing leaves without a decision', async () => {
    const { rows } = await db.as(
      USER_A,
      `insert into public.calendars (workspace_id) values ($1) returning export_policy`,
      [wsA],
    )
    expect(rows[0]!['export_policy']).toBe('none')
  })
})

describe('there is no unencrypted storage path', () => {
  it('admits exactly one algorithm, and it is real AEAD', async () => {
    const { rows } = await db.raw(
      `select e.enumlabel from pg_type t
       join pg_enum e on e.enumtypid = t.oid
       where t.typname = 'cloak_alg' order by e.enumsortorder`,
    )
    expect(rows.map((r) => r['enumlabel'])).toEqual(['aes-256-gcm-v1'])
  })

  it('cannot even name the development null codec', async () => {
    await expect(
      db.as(
        USER_A,
        `insert into public.cloaked_fields
           (subject_type, subject_id, workspace_id, field_name, ciphertext, nonce, alg)
         values ('calendar', $1, $2, 'display_name', decode('00','hex'), decode('000000000000000000000000','hex'), 'plaintext-v0')`,
        [calA, wsA],
      ),
    ).rejects.toThrow(/invalid input value for enum/i)
  })

  it('requires a nonce on every row', async () => {
    const nonce = (await columnsOf('cloaked_fields')).find((c) => c['column_name'] === 'nonce')
    expect(nonce?.['is_nullable']).toBe('NO')
  })

  it('holds ciphertext as bytea, never text', async () => {
    const col = (await columnsOf('cloaked_fields')).find((c) => c['column_name'] === 'ciphertext')
    expect(col?.['data_type']).toBe('bytea')
  })

  it('stores one row per field so fields can be disclosed individually', async () => {
    const { rows } = await db.raw(
      `select indexdef from pg_indexes
       where schemaname='public' and tablename='cloaked_fields' and indexdef ilike '%unique%'`,
    )
    const defs = rows.map((r) => r['indexdef'] as string).join('\n')
    expect(defs).toMatch(/subject_type/)
    expect(defs).toMatch(/subject_id/)
    expect(defs).toMatch(/field_name/)
  })
})

describe('the polymorphic subject is validated', () => {
  const insertField = (
    subjectType: string,
    subjectId: string,
    workspaceId: string,
    fieldName: string,
  ) =>
    db.as(
      USER_A,
      `insert into public.cloaked_fields
         (subject_type, subject_id, workspace_id, field_name, ciphertext, nonce, alg)
       values ($1, $2, $3, $4, decode('00','hex'),
               decode('000000000000000000000000','hex'), 'aes-256-gcm-v1')`,
      [subjectType, subjectId, workspaceId, fieldName],
    )

  it('rejects a field name that is illegal for the subject type', async () => {
    // A calendar has no "title" — only a display_name.
    await expect(insertField('calendar', calA, wsA, 'title')).rejects.toThrow(
      /cloaked_fields_valid_subject_field/,
    )
  })

  it('accepts an extensible custom field on an event', async () => {
    const ev = await db.as(
      USER_A,
      `insert into public.events (workspace_id, calendar_id, owner_id, start_utc, end_utc, timezone)
       values ($1,$2,$3,'2026-09-01T14:00:00Z','2026-09-01T15:00:00Z','UTC') returning id`,
      [wsA, calA, USER_A],
    )
    await expect(
      insertField('event', ev.rows[0]!['id'] as string, wsA, 'custom:case_number'),
    ).resolves.toBeDefined()
  })

  it('rejects a subject that does not belong to the stated workspace', async () => {
    // No foreign key can express this, so a trigger does. Without it, a caller could file
    // a field under a workspace they own while pointing it at a subject they do not, and
    // RLS would allow it because RLS only checks workspace_id.
    const otherWs = await db.as(
      USER_A,
      `insert into public.workspaces (owner_id) values ($1) returning id`,
      [USER_A],
    )
    await expect(
      insertField('calendar', calA, otherWs.rows[0]!['id'] as string, 'display_name'),
    ).rejects.toThrow(/does not belong to workspace/)
  })

  it('rejects a subject id that does not exist at all', async () => {
    await expect(
      insertField('event', '00000000-0000-4000-8000-0000000000ff', wsA, 'title'),
    ).rejects.toThrow(/does not belong to workspace/)
  })
})

describe('event invariants', () => {
  const insertEvent = (extra: string, params: unknown[]) =>
    db.as(
      USER_A,
      `insert into public.events
         (workspace_id, calendar_id, owner_id, start_utc, end_utc, timezone ${extra})
       values ($1,$2,$3,'2026-09-01T14:00:00Z','2026-09-01T15:00:00Z','UTC'
               ${params.length ? `, ${params.map((_, i) => `$${i + 4}`).join(', ')}` : ''})`,
      [wsA, calA, USER_A, ...params],
    )

  it('rejects an event that ends before it starts', async () => {
    await expect(
      db.as(
        USER_A,
        `insert into public.events (workspace_id, calendar_id, owner_id, start_utc, end_utc, timezone)
         values ($1,$2,$3,'2026-09-01T15:00:00Z','2026-09-01T14:00:00Z','UTC')`,
        [wsA, calA, USER_A],
      ),
    ).rejects.toThrow(/events_time_order/)
  })

  it('refuses a recurring series with no local wall-clock anchor', async () => {
    // Without dtstart_local a series has only a UTC instant, and "09:00 every Tuesday"
    // would drift by an hour across a DST boundary.
    await expect(insertEvent(', rrule', ['FREQ=WEEKLY'])).rejects.toThrow(
      /events_rrule_needs_local_anchor/,
    )
  })

  it('accepts a series that has one', async () => {
    await expect(
      insertEvent(', rrule, dtstart_local', ['FREQ=WEEKLY', '2026-09-01 10:00']),
    ).resolves.toBeDefined()
  })

  it('refuses an all-day event stored as timestamps instead of dates', async () => {
    await expect(insertEvent(', all_day', [true])).rejects.toThrow(/events_all_day_dates/)
  })

  it('refuses dates on a timed event', async () => {
    await expect(insertEvent(', start_date, end_date', ['2026-09-01', '2026-09-01'])).rejects.toThrow(
      /events_all_day_dates/,
    )
  })

  it('rejects an all-day range that ends before it starts', async () => {
    await expect(
      insertEvent(', all_day, start_date, end_date', [true, '2026-09-03', '2026-09-01']),
    ).rejects.toThrow(/events_all_day_order/)
  })

  it('rejects a recurrence exception missing its instance start', async () => {
    const parent = await db.as(
      USER_A,
      `insert into public.events
         (workspace_id, calendar_id, owner_id, start_utc, end_utc, timezone, rrule, dtstart_local)
       values ($1,$2,$3,'2026-09-01T14:00:00Z','2026-09-01T15:00:00Z','UTC','FREQ=WEEKLY','2026-09-01 10:00')
       returning id`,
      [wsA, calA, USER_A],
    )
    await expect(
      db.as(
        USER_A,
        `insert into public.events
           (workspace_id, calendar_id, owner_id, start_utc, end_utc, timezone, recurrence_parent_id)
         values ($1,$2,$3,'2026-09-08T14:00:00Z','2026-09-08T15:00:00Z','UTC',$4)`,
        [wsA, calA, USER_A, parent.rows[0]!['id']],
      ),
    ).rejects.toThrow(/events_recurrence_pair/)
  })

  it('rejects a trashed event with no trashed_at timestamp', async () => {
    await expect(insertEvent(', lifecycle', ['trashed'])).rejects.toThrow(/events_trashed_pair/)
  })
})

describe('recurrence exceptions are normalised', () => {
  let seriesId: string

  beforeAll(async () => {
    const row = await db.as(
      USER_A,
      `insert into public.events
         (workspace_id, calendar_id, owner_id, start_utc, end_utc, timezone, rrule, dtstart_local)
       values ($1,$2,$3,'2026-10-06T13:00:00Z','2026-10-06T13:30:00Z','America/New_York',
               'FREQ=WEEKLY;BYDAY=TU','2026-10-06 09:00')
       returning id`,
      [wsA, calA, USER_A],
    )
    seriesId = row.rows[0]!['id'] as string
  })

  it('replaced the unindexable exdates array', async () => {
    const names = (await columnsOf('events')).map((r) => r['column_name'])
    expect(names).not.toContain('exdates')
  })

  it('keys an exception by its original local occurrence, not a UTC instant', async () => {
    // If the key were an instant, a DST shift would change it and a cancelled occurrence
    // would silently reappear.
    const col = (await columnsOf('recurrence_exceptions')).find(
      (c) => c['column_name'] === 'occurrence_local',
    )
    expect(col?.['data_type']).toBe('timestamp without time zone')
  })

  it('cancels an occurrence exactly once', async () => {
    await db.as(
      USER_A,
      `insert into public.recurrence_exceptions (series_id, workspace_id, occurrence_local, kind)
       values ($1,$2,'2026-10-13 09:00','cancelled')`,
      [seriesId, wsA],
    )
    await expect(
      db.as(
        USER_A,
        `insert into public.recurrence_exceptions (series_id, workspace_id, occurrence_local, kind)
         values ($1,$2,'2026-10-13 09:00','cancelled')`,
        [seriesId, wsA],
      ),
    ).rejects.toThrow(/duplicate key|unique/i)
  })

  it('requires a replacement for a moved occurrence', async () => {
    await expect(
      db.as(
        USER_A,
        `insert into public.recurrence_exceptions (series_id, workspace_id, occurrence_local, kind)
         values ($1,$2,'2026-10-20 09:00','moved')`,
        [seriesId, wsA],
      ),
    ).rejects.toThrow(/recurrence_exceptions_moved_pair/)
  })
})
