import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { USER_A, USER_B, createTestDb, type TestDb } from './harness.js'

/**
 * trash_cloaked_event — the one path a browser deletes an event through.
 *
 * Same shape as create_cloaked_event, and tested for the same two things: that SECURITY
 * INVOKER genuinely means RLS applies (a definer-rights version would pass the happy path
 * and quietly let user B delete user A's calendar), and that the version guard turns a
 * concurrent edit into a refusal rather than a silent overwrite.
 *
 * The third thing under test is that trashing is REVERSIBLE. The row survives, and so do its
 * cloaked fields — if either were deleted here the trash would be a purge wearing a friendly
 * name, and the "Undo" this enables could never be built.
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
    $7::timestamp, false, null, null, null, 'busy', $8::jsonb
  ) as id`

const TRASH = `select public.trash_cloaked_event($1::uuid, $2::integer)`

describe('trash_cloaked_event', () => {
  let db: TestDb
  let workspaceA: string
  let calendarA: string

  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

  /** Create an event owned by user A and hand back its id. */
  const seed = async (n: number) => {
    const id = uuid(n)
    await db.as(USER_A, CREATE, [
      id,
      workspaceA,
      calendarA,
      'America/New_York',
      '2026-05-19T13:00:00Z',
      '2026-05-19T13:30:00Z',
      '2026-05-19 09:00:00',
      JSON.stringify([field('title', n)]),
    ])
    return id
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

  it('moves the event to the trash and bumps its version', async () => {
    const id = await seed(1)
    await db.as(USER_A, TRASH, [id, 1])

    const { rows } = await db.as(
      USER_A,
      `select lifecycle::text as lifecycle, version, trashed_at is not null as stamped
         from public.events where id = $1`,
      [id],
    )
    expect(rows).toEqual([{ lifecycle: 'trashed', version: 2, stamped: true }])
  })

  it('keeps the sealed fields, so the trash is reversible', async () => {
    // A purge is a separate, explicit action. Deleting content here would make "Undo"
    // impossible to build later and turn a soft delete into a hard one by accident.
    const { rows } = await db.as(
      USER_A,
      'select field_name from public.cloaked_fields where subject_id = $1',
      [uuid(1)],
    )
    expect(rows).toEqual([{ field_name: 'title' }])
  })

  it('drops the event out of the active read path', async () => {
    // The read path filters on lifecycle = 'active', so this is what "deleted" means to
    // every query the calendar actually runs.
    const { rows } = await db.as(
      USER_A,
      `select id from public.events where id = $1 and lifecycle = 'active'`,
      [uuid(1)],
    )
    expect(rows).toEqual([])
  })

  it('records the deletion without naming anything', async () => {
    const { rows } = await db.as(
      USER_A,
      `select action, detail from public.audit_log
        where subject_id = $1 and action = 'event.trashed'`,
      [uuid(1)],
    )
    expect(rows).toHaveLength(1)
    const entry = rows[0] as { action: string; detail: Record<string, unknown> }
    expect(entry.detail).toEqual({ from_version: 1 })
    expect(JSON.stringify(entry)).not.toMatch(/title|location|notes/u)
  })

  it('refuses a stale version rather than deleting anyway', async () => {
    const id = await seed(2)
    // Two tabs open on the same calendar is the ordinary case. The second one must lose.
    await expect(db.as(USER_A, TRASH, [id, 99])).rejects.toThrow(/changed by someone else/u)
  })

  it('leaves the event untouched after a rejected delete', async () => {
    const { rows } = await db.as(
      USER_A,
      `select lifecycle::text as lifecycle, version from public.events where id = $1`,
      [uuid(2)],
    )
    expect(rows).toEqual([{ lifecycle: 'active', version: 1 }])
  })

  it('refuses to trash the same event twice', async () => {
    const id = await seed(3)
    await db.as(USER_A, TRASH, [id, 1])
    // Version 2 is now correct, so this is not a version conflict — it is a different
    // failure, and the message has to say so or the UI cannot explain itself.
    await expect(db.as(USER_A, TRASH, [id, 2])).rejects.toThrow(/already trashed/u)
  })

  it('reports a missing event as missing', async () => {
    await expect(db.as(USER_A, TRASH, [uuid(404), 1])).rejects.toThrow(/does not exist/u)
  })

  it('will not let another user delete your event', async () => {
    const id = await seed(4)
    // SECURITY INVOKER is the whole reason this fails. RLS hides the row from user B, so
    // the function cannot tell them apart from a bad id — which is the right disclosure.
    await expect(db.as(USER_B, TRASH, [id, 1])).rejects.toThrow(/does not exist/u)
  })

  it('leaves that event active', async () => {
    const { rows } = await db.as(
      USER_A,
      `select lifecycle::text as lifecycle from public.events where id = $1`,
      [uuid(4)],
    )
    expect(rows).toEqual([{ lifecycle: 'active' }])
  })

  it('is not callable anonymously', async () => {
    await expect(db.asAnon(TRASH, [uuid(1), 1])).rejects.toThrow()
  })

  it('is not callable by the unauthenticated role at all', async () => {
    // Stronger than the test above, and the one that actually matters. `asAnon` is the
    // authenticated role without a subject; THIS is Supabase's `anon` role, which is what a
    // request with no session actually arrives as. It must be refused at the privilege
    // level — before the function body runs — not by RLS finding no rows once inside.
    await expect(db.asUnauthenticated(TRASH, [uuid(1), 1])).rejects.toThrow(/permission denied/iu)
  })

  it('grants execute to authenticated and to nobody else', async () => {
    const { rows } = await db.raw(
      `select has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
              has_function_privilege('anon',          p.oid, 'execute') as anon
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'trash_cloaked_event'`,
    )
    expect(rows).toEqual([{ authenticated: true, anon: false }])
  })

  it('runs as invoker, so it grants no privilege the caller lacked', async () => {
    const { rows } = await db.raw(
      `select prosecdef from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'trash_cloaked_event'`,
    )
    expect(rows).toEqual([{ prosecdef: false }])
  })
})
