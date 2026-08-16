import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { HOLIDAY_REGIONS } from '@cloakcal/domain'
import { USER_A, USER_B, createTestDb, type TestDb } from './harness.js'

/**
 * holiday_region (0026).
 *
 * Two things are being pinned. The tri-state — auto / off / a code — behaves, and the region
 * list in the CHECK constraint agrees with the one in packages/domain. That second test is
 * the point of this file: the list is deliberately written twice, because the database is the
 * last thing that stops a junk value being stored and it cannot import TypeScript. Two
 * copies with an assertion between them is the same shape as the policy engine's contract
 * test; two copies with nothing between them is how they drift.
 */

const hintOf = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run
  } catch (caught) {
    return (caught as { hint?: string }).hint ?? `NO HINT: ${String(caught)}`
  }
  return 'NO ERROR'
}

describe('holiday prefs', () => {
  let db: TestDb
  let ws: string

  const setRegion = (user: string, workspace: string, region: string | null) =>
    db.as(
      user,
      'select public.set_workspace_prefs($1::uuid, null, null, null, null, $2::text)',
      [workspace, region],
    )

  const regionOf = async (): Promise<unknown> => {
    const { rows } = await db.as(USER_A, 'select holiday_region from public.workspaces')
    return rows[0]?.['holiday_region']
  }

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

  it("defaults to 'auto', which is holidays ON", async () => {
    // Deliberate: the feature's value is being there without being asked for, and the
    // fail-direction is a public date on screen nobody wanted. Nothing here is user data.
    expect(await regionOf()).toBe('auto')
  })

  it('stores an explicit region and an explicit off', async () => {
    await setRegion(USER_A, ws, 'GB')
    expect(await regionOf()).toBe('GB')

    await setRegion(USER_A, ws, 'off')
    expect(await regionOf()).toBe('off')

    await setRegion(USER_A, ws, 'auto')
    expect(await regionOf()).toBe('auto')
  })

  it('leaves the region alone when the parameter is null', async () => {
    await setRegion(USER_A, ws, 'NZ')
    await db.as(
      USER_A,
      // Every other pref moving at once, holiday_region not named.
      'select public.set_workspace_prefs($1::uuid, $2::text, $3::integer, $4::text, $5::boolean)',
      [ws, 'Europe/Vienna', 1, 'month', true],
    )
    expect(await regionOf()).toBe('NZ')
  })

  it('refuses a region outside the catalog with a slug, not a constraint name', async () => {
    expect(await hintOf(setRegion(USER_A, ws, 'DE'))).toBe('unknown_holiday_region')
    expect(await hintOf(setRegion(USER_A, ws, 'us'))).toBe('unknown_holiday_region')
    expect(await hintOf(setRegion(USER_A, ws, ''))).toBe('unknown_holiday_region')
    // The failed writes changed nothing.
    expect(await regionOf()).toBe('NZ')
  })

  it('refuses a direct write of a junk region, so the RPC is not the only gate', async () => {
    // The RPC raises a friendly slug; the CHECK is what holds if anything ever writes the
    // column directly. Both, because a validation that exists in one place is a validation
    // that moves when that place is refactored.
    await expect(
      db.as(USER_A, `update public.workspaces set holiday_region = 'DE'`),
    ).rejects.toThrow(/workspaces_holiday_region_known/)
  })

  it("does not let someone else's workspace be touched", async () => {
    expect(await hintOf(setRegion(USER_B, ws, 'US'))).toBe('workspace_not_found')
    expect(await regionOf()).toBe('NZ')
  })

  it('audits which pref changed without recording anything about an event', async () => {
    await setRegion(USER_A, ws, 'IE')
    const { rows } = await db.as(
      USER_A,
      `select detail from public.audit_log
        where action = 'workspace.prefs'
        order by created_at desc limit 1`,
    )
    expect(rows[0]?.['detail']).toEqual({ holiday_region: 'IE' })
  })

  it('accepts every region the app can offer, and the two lists agree', async () => {
    // THE test in this file. The CHECK constraint and HOLIDAY_REGIONS are two copies of one
    // list; a region added to the picker but not the constraint is a setting that throws on
    // save, and one added to the constraint but not the picker is dead schema.
    for (const { id } of HOLIDAY_REGIONS) {
      await setRegion(USER_A, ws, id)
      expect(await regionOf()).toBe(id)
    }

    const sql = await readFile(
      fileURLToPath(new URL('../migrations/0026_holiday_prefs.sql', import.meta.url)),
      'utf8',
    )
    const constraint = /check \(holiday_region in \(([^)]+)\)\)/u.exec(sql)?.[1]
    expect(constraint, 'the CHECK constraint moved or was renamed').toBeDefined()

    const inSql = [...(constraint ?? '').matchAll(/'([^']+)'/gu)]
      .map((m) => m[1])
      .filter((value) => value !== 'auto' && value !== 'off')
    expect([...inSql].sort()).toEqual([...HOLIDAY_REGIONS.map((r) => r.id)].sort())
  })
})
