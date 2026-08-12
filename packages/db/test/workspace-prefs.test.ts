import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { USER_A, USER_B, createTestDb, type TestDb } from './harness.js'

/**
 * set_workspace_prefs (0018).
 *
 * The interesting property is what the CHECK deliberately does NOT do: validate against
 * the tz database. PGlite's tz table must never be load-bearing for what the app accepts,
 * so the constraint is a shape check and real validation lives client-side — these tests
 * pin that split by accepting a well-shaped zone PGlite has never heard of.
 */

const hintOf = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run
  } catch (caught) {
    return (caught as { hint?: string }).hint ?? `NO HINT: ${String(caught)}`
  }
  return 'NO ERROR'
}

describe('workspace prefs', () => {
  let db: TestDb
  let ws: string
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

  const setPrefs = (user: string, workspace: string, tz: string | null, weekStart: number | null) =>
    db.as(user, 'select public.set_workspace_prefs($1::uuid, $2::text, $3::integer)', [
      workspace,
      tz,
      weekStart,
    ])

  beforeAll(async () => {
    db = await createTestDb()
    await db.createUser(USER_A, 'a@example.test')
    await db.createUser(USER_B, 'b@example.test')
    const { rows } = await db.as(
      USER_A,
      'insert into public.workspaces (owner_id) values ($1) returning id',
      [USER_A],
    )
    ws = rows[0]!['id'] as string
  })

  afterAll(async () => {
    await db.close()
  })

  it('defaults every workspace to the historical constant', async () => {
    const { rows } = await db.as(USER_A, 'select timezone, week_start from public.workspaces')
    expect(rows[0]).toEqual({ timezone: 'America/New_York', week_start: 0 })
  })

  it('sets both prefs, and null leaves a pref unchanged', async () => {
    await setPrefs(USER_A, ws, 'Europe/Vienna', 1)
    let { rows } = await db.as(USER_A, 'select timezone, week_start from public.workspaces')
    expect(rows[0]).toEqual({ timezone: 'Europe/Vienna', week_start: 1 })

    await setPrefs(USER_A, ws, null, 3)
    ;({ rows } = await db.as(USER_A, 'select timezone, week_start from public.workspaces'))
    expect(rows[0]).toEqual({ timezone: 'Europe/Vienna', week_start: 3 })
  })

  it('accepts a well-shaped zone the database has never heard of', async () => {
    // The shape check is not IANA validation, on purpose. If this ever starts failing,
    // someone made Postgres's tz table load-bearing — see the migration header.
    await setPrefs(USER_A, ws, 'Planet/Arrakis', null)
    const { rows } = await db.as(USER_A, 'select timezone from public.workspaces')
    expect(rows[0]!['timezone']).toBe('Planet/Arrakis')
  })

  it('refuses a value that is not shaped like a zone name', async () => {
    expect(await hintOf(setPrefs(USER_A, ws, 'not a zone; drop table', null))).toBe(
      'unknown_timezone',
    )
  })

  it('refuses a weekday index off the end of the week', async () => {
    expect(await hintOf(setPrefs(USER_A, ws, null, 7))).toBe('invalid_week_start')
    expect(await hintOf(setPrefs(USER_A, ws, null, -1))).toBe('invalid_week_start')
  })

  it('makes someone else\'s workspace look missing, not forbidden', async () => {
    expect(await hintOf(setPrefs(USER_B, ws, 'Europe/London', null))).toBe('workspace_not_found')
    // And the value is untouched.
    const { rows } = await db.as(USER_A, 'select timezone from public.workspaces')
    expect(rows[0]!['timezone']).toBe('Planet/Arrakis')
  })

  it('does not exist for a workspace that does not exist', async () => {
    expect(await hintOf(setPrefs(USER_A, uuid(99), 'Europe/London', null))).toBe(
      'workspace_not_found',
    )
  })

  it('is not callable without a session', async () => {
    await expect(
      db.asUnauthenticated('select public.set_workspace_prefs($1::uuid, $2::text, $3::integer)', [
        ws,
        'Europe/London',
        null,
      ]),
    ).rejects.toThrow()
  })
})
