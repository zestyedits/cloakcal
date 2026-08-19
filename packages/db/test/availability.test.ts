import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { USER_A, USER_B, createTestDb, type TestDb } from './harness.js'

/**
 * set_availability and availability_windows (0027).
 *
 * The two properties worth the file: replace-all really replaces (a save that only inserted
 * would leave yesterday's Friday behind, and nothing on screen would say so), and overlapping
 * windows are refused BEFORE the delete, so a rejected save leaves the stored week intact
 * rather than half-applied.
 *
 * Hint slugs throughout, never Postgres prose — the same rule passkey-wrap.test.ts follows.
 */

const hintOf = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run
  } catch (caught) {
    return (caught as { hint?: string }).hint ?? `NO HINT: ${String(caught)}`
  }
  return 'NO ERROR'
}

interface Window {
  weekday: number
  start_minute: number
  end_minute: number
}

describe('availability', () => {
  let db: TestDb
  let ws: string

  const set = (user: string, workspace: string, windows: Window[]) =>
    db.as(user, 'select public.set_availability($1::uuid, $2::jsonb)', [
      workspace,
      JSON.stringify(windows),
    ])

  const stored = async (): Promise<Window[]> => {
    const { rows } = await db.as(
      USER_A,
      `select weekday, start_minute, end_minute from public.availability_windows
        order by weekday, start_minute`,
    )
    return rows.map((r) => ({
      weekday: Number(r['weekday']),
      start_minute: Number(r['start_minute']),
      end_minute: Number(r['end_minute']),
    }))
  }

  const nineToFive = (weekday: number): Window => ({
    weekday,
    start_minute: 9 * 60,
    end_minute: 17 * 60,
  })

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

  it('starts with no rows, which means NOT SET rather than unavailable', async () => {
    // Absence is the same trick 0024 uses for the plan: no bootstrap insert, nothing to race,
    // and the harmless failure direction — a workspace with no availability shades nothing
    // rather than shading everything and looking broken on day one.
    expect(await stored()).toEqual([])
  })

  it('stores a week, including two windows on one day', async () => {
    await set(USER_A, ws, [
      { weekday: 1, start_minute: 540, end_minute: 720 },
      { weekday: 1, start_minute: 780, end_minute: 1020 },
      nineToFive(2),
    ])
    expect(await stored()).toEqual([
      { weekday: 1, start_minute: 540, end_minute: 720 },
      { weekday: 1, start_minute: 780, end_minute: 1020 },
      { weekday: 2, start_minute: 540, end_minute: 1020 },
    ])
  })

  it('REPLACES the week rather than adding to it', async () => {
    // The one that matters. A save that only inserted would leave the previous Tuesday
    // sitting underneath the new one, and the screen would show both with nothing to
    // explain where the extra band came from.
    await set(USER_A, ws, [nineToFive(3)])
    expect(await stored()).toEqual([{ weekday: 3, start_minute: 540, end_minute: 1020 }])
  })

  it('clears the week when handed an empty array', async () => {
    await set(USER_A, ws, [])
    expect(await stored()).toEqual([])
    await set(USER_A, ws, [nineToFive(1), nineToFive(2)])
  })

  it('refuses overlapping windows on one day, and changes nothing', async () => {
    const before = await stored()
    expect(
      await hintOf(
        set(USER_A, ws, [
          { weekday: 4, start_minute: 540, end_minute: 720 },
          { weekday: 4, start_minute: 700, end_minute: 1020 },
        ]),
      ),
    ).toBe('windows_overlap')
    // Rejected BEFORE the delete, so the stored week survives a bad save intact. A check
    // that ran after the delete would leave the user with no availability at all and an
    // error message, which is the worst of both.
    expect(await stored()).toEqual(before)
  })

  it('allows two windows that merely touch', async () => {
    // 12:00 to 13:00 then 13:00 to 17:00 is a lunch break expressed as two windows, not an
    // overlap. `start < previous.end` is the comparison; `<=` would reject this.
    await set(USER_A, ws, [
      { weekday: 5, start_minute: 720, end_minute: 780 },
      { weekday: 5, start_minute: 780, end_minute: 1020 },
    ])
    expect(await stored()).toHaveLength(2)
    await set(USER_A, ws, [nineToFive(1), nineToFive(2)])
  })

  it('refuses a window that ends before it starts, or falls outside the day', async () => {
    expect(
      await hintOf(set(USER_A, ws, [{ weekday: 1, start_minute: 600, end_minute: 600 }])),
    ).toBe('window_ends_before_start')
    expect(
      await hintOf(set(USER_A, ws, [{ weekday: 1, start_minute: 600, end_minute: 1441 }])),
    ).toBe('window_outside_day')
    expect(
      await hintOf(set(USER_A, ws, [{ weekday: 9, start_minute: 600, end_minute: 700 }])),
    ).toBe('invalid_weekday')
  })

  it('refuses anything that is not an array of complete windows', async () => {
    expect(
      await hintOf(
        db.as(USER_A, 'select public.set_availability($1::uuid, $2::jsonb)', [ws, '{}']),
      ),
    ).toBe('windows_not_array')
    expect(await hintOf(set(USER_A, ws, [{ weekday: 1 } as Window]))).toBe('window_incomplete')
  })

  it('lets the owner write directly, and the overlap rule is NOT a security boundary', async () => {
    /*
     * Stated as a test rather than left as an assumption, because the tempting claim is the
     * false one. `set_availability` is SECURITY INVOKER, so it runs with the caller's
     * privileges: if `authenticated` could not insert, neither could the function, and
     * SECURITY DEFINER is banned outright by security-posture.test.ts. So the caller holds
     * INSERT, and a client bypassing the RPC can store overlapping windows.
     *
     * That is acceptable and bounded: it is their own workspace, RLS still stops them
     * reaching anyone else's, and the blast radius is two bands of shading on their own
     * calendar. What it means for the code is that NOTHING DOWNSTREAM MAY ASSUME
     * NON-OVERLAP — server/availability.ts merges windows rather than trusting them.
     */
    await set(USER_A, ws, [nineToFive(1)])
    await db.as(
      USER_A,
      `insert into public.availability_windows (workspace_id, weekday, start_minute, end_minute)
       values ($1, 1, 600, 1200)`,
      [ws],
    )
    expect(await stored()).toHaveLength(2)
    await set(USER_A, ws, [nineToFive(1), nineToFive(2)])
  })

  it("refuses a direct write into someone else's workspace", async () => {
    // The boundary that IS real. RLS is coarse row authorisation and this is the whole of
    // what it decides here.
    await expect(
      db.as(
        USER_B,
        `insert into public.availability_windows (workspace_id, weekday, start_minute, end_minute)
         values ($1, 1, 540, 1020)`,
        [ws],
      ),
    ).rejects.toThrow()
  })

  it("will not touch another user's workspace, and says only that it is missing", async () => {
    const before = await stored()
    expect(await hintOf(set(USER_B, ws, [nineToFive(0)]))).toBe('workspace_not_found')
    // Checked BEFORE the delete: without that, a caller pointing at a workspace they cannot
    // see would delete nothing, insert nothing, and be told it all went fine.
    expect(await stored()).toEqual(before)
  })

  it('shows nothing to another user', async () => {
    const { rows } = await db.as(
      USER_B,
      'select count(*)::int as n from public.availability_windows',
    )
    expect(rows[0]?.['n']).toBe(0)
  })

  it('is unreachable without a session', async () => {
    // asUnauthenticated, not asAnon: asAnon is the `authenticated` role with no subject,
    // which is a different thing entirely (CLAUDE.md).
    await expect(
      db.asUnauthenticated('select count(*) from public.availability_windows'),
    ).rejects.toThrow()
  })

  it('goes away with its workspace', async () => {
    /*
     * The workspace delete runs through db.raw, not as USER_A, and that is not a shortcut:
     * 0030 took DELETE on `workspaces` away from `authenticated` entirely, so an operator
     * removing an account by hand is now the only way this row is ever removed. The cascade
     * being tested is unchanged and still worth pinning; only who can trigger it moved.
     */
    const { rows } = await db.as(
      USER_A,
      'insert into public.workspaces (owner_id) values ($1) returning id',
      [USER_A],
    )
    const doomed = rows[0]!['id'] as string
    await set(USER_A, doomed, [nineToFive(6)])
    await db.raw('delete from public.workspaces where id = $1', [doomed])
    const { rows: left } = await db.as(
      USER_A,
      'select count(*)::int as n from public.availability_windows where workspace_id = $1',
      [doomed],
    )
    expect(left[0]?.['n']).toBe(0)
  })
})
