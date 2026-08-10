import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { createTestDb, USER_A, USER_B, type TestDb } from './harness.js'

/**
 * Workspace isolation is the M0 gate.
 *
 * Spec §3: "Workspaces are real boundaries, not cosmetic folders." These tests are what
 * turns that sentence into something a machine can check. Every assertion runs as the
 * non-superuser `authenticated` role, because a superuser bypasses RLS and would make
 * the entire suite pass vacuously.
 */

let db: TestDb
let wsA: string
let calA: string
let eventA: string
let wsB: string
let calB: string

beforeAll(async () => {
  db = await createTestDb()
  await db.createUser(USER_A, 'a@example.test')
  await db.createUser(USER_B, 'b@example.test')

  const insertWorkspace = async (user: string) => {
    const { rows } = await db.as(
      user,
      `insert into public.workspaces (owner_id, kind) values ($1, 'personal') returning id`,
      [user],
    )
    return rows[0]!['id'] as string
  }
  const insertCalendar = async (user: string, ws: string) => {
    const { rows } = await db.as(
      user,
      `insert into public.calendars (workspace_id, is_default) values ($1, true) returning id`,
      [ws],
    )
    return rows[0]!['id'] as string
  }

  wsA = await insertWorkspace(USER_A)
  calA = await insertCalendar(USER_A, wsA)
  wsB = await insertWorkspace(USER_B)
  calB = await insertCalendar(USER_B, wsB)

  const { rows } = await db.as(
    USER_A,
    `insert into public.events
       (workspace_id, calendar_id, owner_id, start_utc, end_utc, timezone)
     values ($1, $2, $3, '2026-09-01T14:00:00Z', '2026-09-01T15:00:00Z', 'America/New_York')
     returning id`,
    [wsA, calA, USER_A],
  )
  eventA = rows[0]!['id'] as string

  // Opaque bytes are enough here: this suite is about who may reach the row, not about
  // whether the ciphertext decrypts. Crypto correctness is covered in packages/crypto.
  await db.as(
    USER_A,
    `insert into public.cloaked_fields
       (subject_type, subject_id, workspace_id, field_name, ciphertext, nonce, alg)
     values ('event', $1, $2, 'title', decode('deadbeef', 'hex'),
             decode('000000000000000000000000', 'hex'), 'aes-256-gcm-v1')`,
    [eventA, wsA],
  )
})

afterAll(async () => {
  await db.close()
})

describe('RLS is switched on everywhere', () => {
  it('leaves no table in public without row level security', async () => {
    const { rows } = await db.raw(`
      select c.relname as table_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
      order by 1
    `)
    expect(rows.map((r) => r['table_name'])).toEqual([])
  })

  it('forces RLS so even the table owner cannot bypass a policy', async () => {
    const { rows } = await db.raw(`
      select c.relname as table_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relforcerowsecurity
      order by 1
    `)
    expect(rows.map((r) => r['table_name'])).toEqual([])
  })
})

describe('owner access', () => {
  it('lets the owner read their own workspace, calendar and event', async () => {
    const ws = await db.as(USER_A, 'select id from public.workspaces')
    expect(ws.rows.map((r) => r['id'])).toEqual([wsA])

    const ev = await db.as(USER_A, 'select id from public.events')
    expect(ev.rows.map((r) => r['id'])).toEqual([eventA])
  })
})

describe('cross-workspace reads are blocked', () => {
  it.each([
    ['workspaces', 'select id from public.workspaces'],
    ['recurrence_exceptions', 'select id from public.recurrence_exceptions'],
    ['calendars', 'select id from public.calendars'],
    ['events', 'select id from public.events'],
    ['cloaked_fields', 'select id from public.cloaked_fields'],
    ['visibility_rules', 'select id from public.visibility_rules'],
    ['presets', 'select id from public.presets'],
    ['access_envelopes', 'select id from public.access_envelopes'],
    ['audit_log', 'select id from public.audit_log'],
  ])('user B sees none of user A rows in %s', async (_table, sql) => {
    const { rows } = await db.as(USER_B, sql)
    const ids = rows.map((r) => r['id'])
    expect(ids).not.toContain(wsA)
    expect(ids).not.toContain(calA)
    expect(ids).not.toContain(eventA)
  })

  it('hides even the existence of another user event by id', async () => {
    const { rows } = await db.as(USER_B, 'select id from public.events where id = $1', [eventA])
    expect(rows).toHaveLength(0)
  })

  it('never leaks cloaked ciphertext across the boundary', async () => {
    const { rows } = await db.as(USER_B, 'select ciphertext from public.cloaked_fields')
    expect(rows).toHaveLength(0)
  })
})

describe('cross-workspace writes are blocked', () => {
  it('stops user B inserting an event into user A workspace', async () => {
    await expect(
      db.as(
        USER_B,
        `insert into public.events
           (workspace_id, calendar_id, owner_id, start_utc, end_utc, timezone)
         values ($1, $2, $3, '2026-09-02T10:00:00Z', '2026-09-02T11:00:00Z', 'UTC')`,
        [wsA, calA, USER_B],
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('stops user B claiming ownership of an event inside their own workspace', async () => {
    // owner_id must equal the caller: the WITH CHECK on events_all guards this.
    await expect(
      db.as(
        USER_B,
        `insert into public.events
           (workspace_id, calendar_id, owner_id, start_utc, end_utc, timezone)
         values ($1, $2, $3, '2026-09-02T10:00:00Z', '2026-09-02T11:00:00Z', 'UTC')`,
        [wsB, calB, USER_A],
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('stops user B updating user A event', async () => {
    const { rows } = await db.as(
      USER_B,
      `update public.events set busy = 'free' where id = $1 returning id`,
      [eventA],
    )
    // No policy error — the row is simply invisible, so zero rows match. Either way the
    // event must be untouched; a silent no-op is the correct RLS outcome for UPDATE.
    expect(rows).toHaveLength(0)

    const check = await db.as(USER_A, 'select busy from public.events where id = $1', [eventA])
    expect(check.rows[0]!['busy']).toBe('busy')
  })

  it('stops user B deleting user A event', async () => {
    await db.as(USER_B, 'delete from public.events where id = $1', [eventA])
    const check = await db.as(USER_A, 'select id from public.events where id = $1', [eventA])
    expect(check.rows).toHaveLength(1)
  })

  it('stops a workspace being moved to another owner', async () => {
    // Raises rather than no-ops: USING passes (A owns the row today) but WITH CHECK
    // rejects what the row would become. That distinction is the point — a silent
    // 0-row result here would mean the row was invisible, which it is not.
    await expect(
      db.as(USER_A, 'update public.workspaces set owner_id = $1 where id = $2', [USER_B, wsA]),
    ).rejects.toThrow(/row-level security/i)

    const still = await db.as(USER_A, 'select owner_id from public.workspaces where id = $1', [wsA])
    expect(still.rows[0]!['owner_id']).toBe(USER_A)
  })
})

describe('anonymous callers', () => {
  it.each([
    ['workspaces', 'select id from public.workspaces'],
    ['events', 'select id from public.events'],
    ['cloaked_fields', 'select id from public.cloaked_fields'],
  ])('see nothing in %s', async (_table, sql) => {
    const { rows } = await db.asAnon(sql)
    expect(rows).toHaveLength(0)
  })
})

describe('audit log is append-only', () => {
  it('accepts an insert from the workspace owner', async () => {
    const { rows } = await db.as(
      USER_A,
      `insert into public.audit_log (workspace_id, actor_id, action)
       values ($1, $2, 'event.created') returning id`,
      [wsA, USER_A],
    )
    expect(rows).toHaveLength(1)
  })

  it('refuses attribution of an entry to another actor', async () => {
    await expect(
      db.as(
        USER_A,
        `insert into public.audit_log (workspace_id, actor_id, action)
         values ($1, $2, 'event.created')`,
        [wsA, USER_B],
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('cannot be updated or deleted, so history cannot be rewritten', async () => {
    const before = await db.as(USER_A, 'select id, action from public.audit_log order by id')
    expect(before.rows.length).toBeGreaterThan(0)

    // Denied at the privilege level, not merely by an absent policy — see the REVOKE
    // in 0002_rls.sql. A future permissive policy still cannot reopen this.
    await expect(
      db.as(USER_A, `update public.audit_log set action = 'tampered' where workspace_id = $1`, [
        wsA,
      ]),
    ).rejects.toThrow(/permission denied/i)

    await expect(
      db.as(USER_A, 'delete from public.audit_log where workspace_id = $1', [wsA]),
    ).rejects.toThrow(/permission denied/i)

    const after = await db.as(USER_A, 'select id, action from public.audit_log order by id')
    expect(after.rows).toEqual(before.rows)
  })
})
