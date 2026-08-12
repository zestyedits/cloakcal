import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { USER_A, USER_B, createTestDb, type TestDb } from './harness.js'

/**
 * Group management RPCs (0020).
 *
 * The two properties worth their tests:
 *   1. Changing a group's priority SYNCS the denormalised copy on its existing rules —
 *      otherwise the D8 tiebreak can see two priorities for one group, which surfaces as
 *      "sometimes she can see it".
 *   2. The cross-workspace FK violation is re-raised as a slug, so the UI never sees a
 *      raw constraint name.
 */

const ciphertext = (byte: number) => Buffer.from(new Uint8Array(24).fill(byte)).toString('hex')
const NONCE = Buffer.from(new Uint8Array(12).fill(7)).toString('hex')

const hintOf = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run
  } catch (caught) {
    return (caught as { hint?: string }).hint ?? `NO HINT: ${String(caught)}`
  }
  return 'NO ERROR'
}

describe('contact group RPCs', () => {
  let db: TestDb
  let wsA: string
  let wsB: string
  let contactA: string
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

  const labelField = (byte = 1) =>
    JSON.stringify([
      { field_name: 'label', ciphertext: ciphertext(byte), nonce: NONCE, alg: 'aes-256-gcm-v1' },
    ])

  const upsertGroup = (
    user: string,
    id: string,
    workspace: string,
    priority: number | null = null,
    fields = '[]',
  ) =>
    db.as(user, 'select public.upsert_contact_group($1::uuid, $2::uuid, $3::integer, $4::jsonb)', [
      id,
      workspace,
      priority,
      fields,
    ])

  beforeAll(async () => {
    db = await createTestDb()
    await db.createUser(USER_A, 'a@example.test')
    await db.createUser(USER_B, 'b@example.test')
    const mkWs = async (user: string) => {
      const { rows } = await db.as(
        user,
        'insert into public.workspaces (owner_id) values ($1) returning id',
        [user],
      )
      return rows[0]!['id'] as string
    }
    wsA = await mkWs(USER_A)
    wsB = await mkWs(USER_B)
    const mkContact = async (user: string, workspace: string) => {
      const { rows } = await db.as(
        user,
        'insert into public.contacts (workspace_id) values ($1) returning id',
        [workspace],
      )
      return rows[0]!['id'] as string
    }
    contactA = await mkContact(USER_A, wsA)
    // USER_B's contact exists so wsB is a populated, realistic neighbour — the RLS tests
    // below reach it through the group, not directly.
    await mkContact(USER_B, wsB)
  })

  afterAll(async () => {
    await db.close()
  })

  it('creates a group with a sealed label and renames it in place', async () => {
    await upsertGroup(USER_A, uuid(1), wsA, 10, labelField(1))
    await upsertGroup(USER_A, uuid(1), wsA, null, labelField(2))

    const { rows } = await db.as(
      USER_A,
      "select count(*)::int as n from public.cloaked_fields where subject_type = 'contact_group' and subject_id = $1",
      [uuid(1)],
    )
    expect(rows[0]!['n']).toBe(1)

    // Null priority left the original value alone.
    const group = await db.as(USER_A, 'select priority from public.contact_groups where id = $1', [
      uuid(1),
    ])
    expect(group.rows[0]!['priority']).toBe(10)
  })

  it('refuses a label that was never encrypted', async () => {
    expect(
      await hintOf(
        upsertGroup(
          USER_A,
          uuid(2),
          wsA,
          null,
          JSON.stringify([
            { field_name: 'label', ciphertext: '00', nonce: NONCE, alg: 'aes-256-gcm-v1' },
          ]),
        ),
      ),
    ).toBe('not_ciphertext')
  })

  it('syncs a priority change onto existing rules for the group', async () => {
    // A rule written at priority 10 carries that denormalised copy (0017 reads it from
    // the group at write time).
    await db.as(USER_A, 'select public.set_visibility_rule($1::uuid, $2, $3::uuid, $4, $5::jsonb)', [
      wsA,
      'group',
      uuid(1),
      'busy',
      '{}',
    ])
    let { rows } = await db.as(
      USER_A,
      'select group_priority from public.visibility_rules where audience_ref = $1',
      [uuid(1)],
    )
    expect(rows[0]!['group_priority']).toBe(10)

    await upsertGroup(USER_A, uuid(1), wsA, 5)
    ;({ rows } = await db.as(
      USER_A,
      'select group_priority from public.visibility_rules where audience_ref = $1',
      [uuid(1)],
    ))
    // The one property this migration exists for: the tiebreak can never see two
    // priorities for one group.
    expect(rows[0]!['group_priority']).toBe(5)
  })

  it('adds and removes members idempotently', async () => {
    await db.as(USER_A, 'select public.add_group_member($1::uuid, $2::uuid)', [uuid(1), contactA])
    await db.as(USER_A, 'select public.add_group_member($1::uuid, $2::uuid)', [uuid(1), contactA])

    let { rows } = await db.as(
      USER_A,
      'select count(*)::int as n from public.contact_group_members where group_id = $1',
      [uuid(1)],
    )
    expect(rows[0]!['n']).toBe(1)

    await db.as(USER_A, 'select public.remove_group_member($1::uuid, $2::uuid)', [uuid(1), contactA])
    await db.as(USER_A, 'select public.remove_group_member($1::uuid, $2::uuid)', [uuid(1), contactA])
    ;({ rows } = await db.as(
      USER_A,
      'select count(*)::int as n from public.contact_group_members where group_id = $1',
      [uuid(1)],
    ))
    expect(rows[0]!['n']).toBe(0)
  })

  it('reports a missing group or contact by name', async () => {
    expect(
      await hintOf(db.as(USER_A, 'select public.add_group_member($1::uuid, $2::uuid)', [uuid(9), contactA])),
    ).toBe('group_not_found')
    expect(
      await hintOf(db.as(USER_A, 'select public.add_group_member($1::uuid, $2::uuid)', [uuid(1), uuid(9)])),
    ).toBe('contact_not_found')
  })

  it('deleting a group takes its rules, label and memberships with it', async () => {
    await db.as(USER_A, 'select public.add_group_member($1::uuid, $2::uuid)', [uuid(1), contactA])
    await db.as(USER_A, 'select public.delete_contact_group($1::uuid)', [uuid(1)])

    for (const [table, where] of [
      ['public.contact_groups', 'id = $1'],
      ['public.contact_group_members', 'group_id = $1'],
      ['public.visibility_rules', 'audience_ref = $1'],
      ["public.cloaked_fields", "subject_type = 'contact_group' and subject_id = $1"],
    ] as const) {
      const { rows } = await db.as(
        USER_A,
        `select count(*)::int as n from ${table} where ${where}`,
        [uuid(1)],
      )
      expect(rows[0]!['n'], table).toBe(0)
    }
  })

  it('re-raises the cross-workspace FK violation as a slug', async () => {
    // Two workspaces, ONE owner — RLS is satisfied on both sides, so only the composite
    // FK stands between a group and a contact from different workspaces. The same-user
    // case is the only one that can reach it: another user's contact reads as missing
    // long before the constraint fires.
    const { rows } = await db.as(
      USER_A,
      'insert into public.workspaces (owner_id) values ($1) returning id',
      [USER_A],
    )
    const wsA2 = rows[0]!['id'] as string
    const foreign = await db.as(
      USER_A,
      'insert into public.contacts (workspace_id) values ($1) returning id',
      [wsA2],
    )
    await upsertGroup(USER_A, uuid(5), wsA)

    expect(
      await hintOf(
        db.as(USER_A, 'select public.add_group_member($1::uuid, $2::uuid)', [
          uuid(5),
          foreign.rows[0]!['id'] as string,
        ]),
      ),
    ).toBe('cross_workspace')
  })

  it('cannot see, edit or delete another user\'s group', async () => {
    await upsertGroup(USER_B, uuid(3), wsB)
    expect(await hintOf(db.as(USER_A, 'select public.delete_contact_group($1::uuid)', [uuid(3)]))).toBe(
      'group_not_found',
    )
  })

  it('is not callable without a session', async () => {
    for (const [sql, params] of [
      ['select public.upsert_contact_group($1::uuid, $2::uuid, null, $3::jsonb)', [uuid(4), wsA, '[]']],
      ['select public.delete_contact_group($1::uuid)', [uuid(4)]],
      ['select public.add_group_member($1::uuid, $2::uuid)', [uuid(4), contactA]],
      ['select public.remove_group_member($1::uuid, $2::uuid)', [uuid(4), contactA]],
    ] as const) {
      await expect(db.asUnauthenticated(sql, [...params])).rejects.toThrow()
    }
  })
})
