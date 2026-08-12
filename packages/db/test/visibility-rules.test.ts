import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { USER_A, USER_B, createTestDb, type TestDb } from './harness.js'

/**
 * Writing contacts and visibility rules (0017).
 *
 * `visibility_rules` had been dead in both directions since 0001 — never read, never written,
 * not even seeded — while `audience.ts` carried two literal rules and four fictional people.
 * These are the writes that make View As control something instead of demonstrating something.
 *
 * The interesting assertion is the UPSERT. "What can Sarah see" is one answer, not a growing
 * list: two rows for one audience would be resolved by the engine's tiebreak, which is
 * deterministic and would still mean the UI showed one setting with a shadow of the previous
 * one behind it. Duplicates have to be unrepresentable, not merely unlikely.
 */

const ciphertext = (byte: number) => Buffer.from(new Uint8Array(24).fill(byte)).toString('hex')
const NONCE = Buffer.from(new Uint8Array(12).fill(7)).toString('hex')

const nameField = (byte: number) => [
  {
    field_name: 'name',
    ciphertext: ciphertext(byte),
    nonce: NONCE,
    alg: 'aes-256-gcm-v1',
    key_version: 1,
  },
]

const hintOf = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run
  } catch (caught) {
    return (caught as { hint?: string }).hint ?? `NO HINT: ${String(caught)}`
  }
  return 'NO ERROR'
}

describe('contact and visibility-rule RPCs', () => {
  let db: TestDb
  let ws: string
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

  const upsertContact = (user: string, id: string, byte = 1) =>
    db.as(user, 'select public.upsert_contact($1::uuid, $2::uuid, $3::jsonb) as id', [
      id,
      ws,
      JSON.stringify(nameField(byte)),
    ])

  const setRule = (
    user: string,
    audience: string,
    ref: string | null,
    timeVis: string,
    fields: Record<string, string> = {},
    eventId: string | null = null,
  ) =>
    db.as(
      user,
      `select public.set_visibility_rule($1::uuid, $2::text, $3::uuid, $4::text, $5::jsonb, $6::uuid) as id`,
      [ws, audience, ref, timeVis, JSON.stringify(fields), eventId],
    )

  beforeAll(async () => {
    db = await createTestDb()
    await db.createUser(USER_A, 'a@example.test')
    await db.createUser(USER_B, 'b@example.test')
    const w = await db.as(
      USER_A,
      'insert into public.workspaces (owner_id) values ($1) returning id',
      [USER_A],
    )
    ws = w.rows[0]!['id'] as string
  })

  afterAll(async () => {
    await db.close()
  })

  it('creates a contact and seals its name', async () => {
    await upsertContact(USER_A, uuid(1))
    const { rows } = await db.as(
      USER_A,
      `select field_name, octet_length(ciphertext) as bytes from public.cloaked_fields
        where subject_type = 'contact' and subject_id = $1`,
      [uuid(1)],
    )
    expect(rows).toEqual([{ field_name: 'name', bytes: 24 }])
  })

  it('renames by replacing the sealed value, not by adding a second one', async () => {
    // (subject_type, subject_id, field_name) is unique, so without the ON CONFLICT a rename
    // would fail outright rather than update.
    await upsertContact(USER_A, uuid(1), 2)
    const { rows } = await db.as(
      USER_A,
      `select count(*)::int as n, max(encode(ciphertext, 'hex')) as ct
         from public.cloaked_fields where subject_type = 'contact' and subject_id = $1`,
      [uuid(1)],
    )
    expect(rows[0]!['n']).toBe(1)
    expect(rows[0]!['ct']).toBe(ciphertext(2))
  })

  it('refuses a name that was never encrypted', async () => {
    // The floor that keeps a plaintext name out of storage even once. ADR 0004's whole point.
    expect(
      await hintOf(
        db.as(USER_A, 'select public.upsert_contact($1::uuid, $2::uuid, $3::jsonb)', [
          uuid(2),
          ws,
          JSON.stringify([
            { field_name: 'name', ciphertext: '00', nonce: NONCE, alg: 'aes-256-gcm-v1' },
          ]),
        ]),
      ),
    ).toBe('not_ciphertext')
  })

  it('stores one rule per audience, overwriting on repeat', async () => {
    const first = await setRule(USER_A, 'individual', uuid(1), 'exact', { title: 'visible' })
    const second = await setRule(USER_A, 'individual', uuid(1), 'busy', {})

    // Same row, not two.
    expect(second.rows[0]!['id']).toBe(first.rows[0]!['id'])

    const { rows } = await db.as(
      USER_A,
      `select count(*)::int as n, max(time_vis::text) as vis
         from public.visibility_rules where audience_ref = $1`,
      [uuid(1)],
    )
    expect(rows).toEqual([{ n: 1, vis: 'busy' }])
  })

  it('keeps workspace defaults and per-event overrides as separate rows', async () => {
    // The unique index coalesces a NULL event_id to a sentinel. Without that, NULL <> NULL
    // would make every workspace-scoped rule distinct from every other and the upsert above
    // would silently become an insert.
    const cal = await db.as(
      USER_A,
      'insert into public.calendars (workspace_id, is_default) values ($1, true) returning id',
      [ws],
    )
    const event = await db.as(
      USER_A,
      `select public.create_cloaked_event($1::uuid, $2::uuid, $3::uuid, 'America/New_York',
         '2026-05-19T13:00:00Z'::timestamptz, '2026-05-19T13:30:00Z'::timestamptz,
         '2026-05-19 09:00:00'::timestamp) as id`,
      [uuid(50), ws, cal.rows[0]!['id']],
    )
    const eventId = event.rows[0]!['id'] as string

    await setRule(USER_A, 'individual', uuid(1), 'exact', { title: 'visible' }, eventId)

    const { rows } = await db.as(
      USER_A,
      `select scope, time_vis::text as vis from public.visibility_rules
        where audience_ref = $1 order by scope`,
      [uuid(1)],
    )
    expect(rows).toEqual([
      { scope: 'event', vis: 'exact' },
      { scope: 'workspace', vis: 'busy' },
    ])
  })

  it('reads a group rule’s priority from the group, not from the caller', async () => {
    // D8 breaks group ties by priority. Taking it as a parameter would let two rules disagree
    // about one group's precedence, and the engine's answer would then depend on write order —
    // which surfaces as "sometimes she can see it".
    const group = await db.as(
      USER_A,
      'insert into public.contact_groups (workspace_id, priority) values ($1, 7) returning id',
      [ws],
    )
    const groupId = group.rows[0]!['id'] as string
    await setRule(USER_A, 'group', groupId, 'busy')

    const { rows } = await db.as(
      USER_A,
      'select group_priority from public.visibility_rules where audience_ref = $1',
      [groupId],
    )
    expect(rows).toEqual([{ group_priority: 7 }])
  })

  it('refuses a group rule for a group that does not exist', async () => {
    expect(await hintOf(setRule(USER_A, 'group', uuid(900), 'busy'))).toBe('group_not_found')
  })

  it.each([
    ['an unknown audience', 'everyone', 'exact', 'unknown_audience'],
    ['an unknown time visibility', 'individual', 'sometimes', 'unknown_time_visibility'],
  ])('refuses %s', async (_label, audience, timeVis, hint) => {
    expect(await hintOf(setRule(USER_A, audience, uuid(1), timeVis))).toBe(hint)
  })

  it('takes the rules and the sealed name with a deleted contact', async () => {
    // Neither cascades on its own: audience_ref and cloaked_fields.subject_id are both
    // polymorphic, so neither can carry a foreign key. Left behind, the name is ciphertext
    // nobody can reach and nothing deletes.
    await upsertContact(USER_A, uuid(3))
    await setRule(USER_A, 'individual', uuid(3), 'exact')
    await db.as(USER_A, 'select public.delete_contact($1::uuid)', [uuid(3)])

    const { rows } = await db.as(
      USER_A,
      `select (select count(*)::int from public.contacts where id = $1)                        as contacts,
              (select count(*)::int from public.visibility_rules where audience_ref = $1)      as rules,
              (select count(*)::int from public.cloaked_fields
                where subject_type = 'contact' and subject_id = $1)                            as names`,
      [uuid(3)],
    )
    expect(rows).toEqual([{ contacts: 0, rules: 0, names: 0 }])
  })

  it('does not let another user write into a workspace they do not own', async () => {
    // SECURITY INVOKER, so RLS applies to the insert. A definer-rights version would pass
    // every test above and fail this one.
    await expect(upsertContact(USER_B, uuid(4))).rejects.toThrow()
    await expect(setRule(USER_B, 'individual', uuid(1), 'exact')).rejects.toThrow()
  })

  it.each([
    'select public.upsert_contact($1::uuid, $1::uuid, \'[]\'::jsonb)',
    'select public.delete_contact($1::uuid)',
    'select public.delete_visibility_rule($1::uuid)',
  ])('is not callable without a session: %s', async (sql) => {
    await expect(db.asUnauthenticated(sql, [uuid(1)])).rejects.toThrow()
  })
})
