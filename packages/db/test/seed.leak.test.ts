import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { uncloakField, type CloakedPayload } from '@cloakcal/crypto'
import { createTestDb, USER_A, type TestDb } from './harness.js'
import { SEED_META, SEED_ROOT_KEY, seedWorkspace } from '../seed/seed.js'

/**
 * Privacy-leakage suite (`pnpm test:leak`).
 *
 * The plan schedules the full suite at M6 across API payloads, notifications, search,
 * logs and exports. This is its foundation: nothing belonging to Tier B may appear
 * anywhere in a Tier A column, and content at rest must be genuine ciphertext.
 *
 * The scan enumerates columns from information_schema rather than a hardcoded list, so a
 * column added by a future migration is scanned automatically. A test that only checks
 * the columns someone remembered to list is exactly the test that misses the leak.
 */

let db: TestDb
let seeded: Awaited<ReturnType<typeof seedWorkspace>>

/** Content strings from the seed. If any surfaces in Tier A, or in storage, we leaked. */
const CANARIES = [
  'Team Standup',
  'Client Meeting',
  'Lunch with Sarah',
  'Legal Call',
  'Project Review',
  'Strategy Session',
  'Dinner with Family',
  '1:1 with Alex',
  'Offsite',
  'Ivy Cafe',
  'Office — Boardroom',
  'Renewal discussion',
  'Do not sync to any external calendar',
  'Keith — Personal',
  'Personal',
  'Work',
  'Private',
  'Family',
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
  seeded = await seedWorkspace((sql, params) => db.as(USER_A, sql, params), USER_A)
})

afterAll(async () => {
  await db.close()
})

describe('the seed produces a usable week', () => {
  it('creates the expected shape', async () => {
    expect(seeded.eventIds).toHaveLength(SEED_META.eventCount)
    expect(Object.keys(seeded.calendars)).toHaveLength(SEED_META.calendarCount)

    const events = await db.as(USER_A, 'select id, all_day, rrule from public.events')
    expect(events.rows).toHaveLength(SEED_META.eventCount)
    expect(events.rows.filter((r) => r['all_day'] === true)).toHaveLength(SEED_META.allDayCount)
    expect(events.rows.filter((r) => r['rrule'] !== null)).toHaveLength(SEED_META.seriesCount)
  })

  it('anchors the recurring series to local wall-clock time', async () => {
    const { rows } = await db.as(
      USER_A,
      'select dtstart_local, timezone from public.events where id = $1',
      [seeded.seriesId],
    )
    expect(rows[0]!['dtstart_local']).toBeTruthy()
    expect(rows[0]!['timezone']).toBe(SEED_META.timezone)
  })

  it('records a cancelled occurrence keyed by local time', async () => {
    const { rows } = await db.as(
      USER_A,
      `select kind from public.recurrence_exceptions where series_id = $1`,
      [seeded.seriesId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!['kind']).toBe('cancelled')
  })
})

describe('content at rest is real ciphertext', () => {
  it('stores every field under AES-256-GCM with a nonce', async () => {
    const { rows } = await db.as(
      USER_A,
      `select field_name, alg, nonce, octet_length(ciphertext) as len from public.cloaked_fields`,
    )
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row['alg']).toBe('aes-256-gcm-v1')
      expect(row['nonce']).toBeTruthy()
      expect(Number(row['len'])).toBeGreaterThan(0)
    }
  })

  it('leaks no plaintext into the ciphertext bytes themselves', async () => {
    const { rows } = await db.as(
      USER_A,
      `select encode(ciphertext, 'escape') as raw from public.cloaked_fields`,
    )
    const haystack = rows.map((r) => String(r['raw'])).join('\n')
    expect(CANARIES.filter((c) => haystack.includes(c))).toEqual([])
  })

  it('decrypts back to the original values with the right key', async () => {
    const { rows } = await db.as(
      USER_A,
      `select subject_id, field_name, ciphertext, nonce, key_version
       from public.cloaked_fields
       where subject_type = 'event' and field_name = 'title'`,
    )

    const titles = await Promise.all(
      rows.map((r) =>
        uncloakField(
          SEED_ROOT_KEY,
          { type: 'event', id: r['subject_id'] as string },
          'title',
          {
            ciphertext: new Uint8Array(r['ciphertext'] as Uint8Array),
            nonce: new Uint8Array(r['nonce'] as Uint8Array),
            alg: 'aes-256-gcm-v1',
            keyVersion: Number(r['key_version']),
          } satisfies CloakedPayload,
        ),
      ),
    )

    expect(titles).toContain('Legal Call')
    expect(titles).toHaveLength(SEED_META.eventCount)
  })
})

describe('no Tier B content leaks into Tier A', () => {
  const textColumnsOf = async (table: string) => {
    const { rows } = await db.raw(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = $1
         and data_type in ('text','character varying','jsonb','json','ARRAY')`,
      [table],
    )
    return rows.map((r) => r['column_name'] as string)
  }

  it.each(TIER_A_TABLES)('%s contains no seeded content', async (table) => {
    const columns = await textColumnsOf(table)
    if (columns.length === 0) return

    const projection = columns.map((c) => `coalesce(${c}::text, '')`).join(" || ' ' || ")
    const { rows } = await db.raw(`select ${projection} as blob from public.${table}`)
    const haystack = rows.map((r) => String(r['blob'])).join('\n')

    expect(CANARIES.filter((canary) => haystack.includes(canary))).toEqual([])
  })

  it('keeps calendar display names out of the calendars table', async () => {
    const { rows } = await db.as(USER_A, 'select * from public.calendars')
    const serialised = JSON.stringify(rows)
    for (const name of ['Personal', 'Work', 'Private', 'Family']) {
      expect(serialised).not.toContain(name)
    }
  })

  it('keeps the workspace display name out of the route token', async () => {
    const { rows } = await db.as(USER_A, 'select route_token from public.workspaces')
    const token = rows[0]!['route_token'] as string
    // 32 hex chars = 128 bits of entropy (widened from 64 bits at M0 review round 2).
    expect(token).toMatch(/^[0-9a-f]{32}$/)
    expect(token).not.toMatch(/personal|keith/i)
  })

  it('keeps content out of the audit log', async () => {
    await db.as(
      USER_A,
      `insert into public.audit_log (workspace_id, actor_id, action, subject_type, subject_id, detail)
       values ($1, $2, 'event.cloaked', 'event', $3, '{"fields":["title","location"]}'::jsonb)`,
      [seeded.workspaceId, USER_A, seeded.eventIds[0]],
    )

    const { rows } = await db.as(USER_A, 'select * from public.audit_log')
    const serialised = JSON.stringify(rows)
    // Field NAMES are metadata and are fine to log; field VALUES are not.
    expect(serialised).toContain('title')
    for (const canary of CANARIES) {
      expect(serialised).not.toContain(canary)
    }
  })
})
