import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { USER_A, USER_B, createTestDb, type TestDb } from './harness.js'

/**
 * Contacts and groups (0015, ADR 0004).
 *
 * Three things are under test, and only the first is routine:
 *
 *   1. RLS isolation — user B cannot read or write user A's address book.
 *   2. A contact's identity really is Cloaked. The table has no name column, and the name
 *      round-trips through `cloaked_fields` under the new `contact` subject type.
 *   3. A GROUP CANNOT SPAN WORKSPACES. This is the one RLS cannot do on its own, and the
 *      reason the membership table carries composite foreign keys rather than plain ones.
 */

const ciphertext = (byte: number) => Buffer.from(new Uint8Array(24).fill(byte)).toString('hex')
const NONCE = Buffer.from(new Uint8Array(12).fill(7)).toString('hex')

describe('contacts and groups', () => {
  let db: TestDb
  let wsA1: string
  let wsA2: string
  let wsB: string

  const makeWorkspace = async (user: string) => {
    const { rows } = await db.as(
      user,
      'insert into public.workspaces (owner_id) values ($1) returning id',
      [user],
    )
    return rows[0]!['id'] as string
  }

  const makeContact = async (user: string, workspace: string) => {
    const { rows } = await db.as(
      user,
      'insert into public.contacts (workspace_id) values ($1) returning id',
      [workspace],
    )
    return rows[0]!['id'] as string
  }

  const makeGroup = async (user: string, workspace: string, priority = 100) => {
    const { rows } = await db.as(
      user,
      'insert into public.contact_groups (workspace_id, priority) values ($1, $2) returning id',
      [workspace, priority],
    )
    return rows[0]!['id'] as string
  }

  beforeAll(async () => {
    db = await createTestDb()
    await db.createUser(USER_A, 'a@example.test')
    await db.createUser(USER_B, 'b@example.test')
    // TWO workspaces for user A. The cross-workspace test below is meaningless with one:
    // the point is that a boundary holds even when the same person owns both sides.
    wsA1 = await makeWorkspace(USER_A)
    wsA2 = await makeWorkspace(USER_A)
    wsB = await makeWorkspace(USER_B)
  })

  afterAll(async () => {
    await db.close()
  })

  it('stores a contact with no identifying column at all', async () => {
    const id = await makeContact(USER_A, wsA1)
    const { rows } = await db.as(
      USER_A,
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'contacts' order by column_name`,
      [],
    )
    expect(rows.map((r) => r['column_name'])).toEqual([
      'created_at',
      'id',
      'updated_at',
      'workspace_id',
    ])
    expect(id).toBeTruthy()
  })

  it('keeps the name in cloaked_fields, under the contact subject type', async () => {
    const id = await makeContact(USER_A, wsA1)
    await db.as(
      USER_A,
      `insert into public.cloaked_fields
         (subject_type, subject_id, workspace_id, field_name, ciphertext, nonce, alg, key_version)
       values ('contact', $1, $2, 'name', decode($3,'hex'), decode($4,'hex'), 'aes-256-gcm-v1', 1)`,
      [id, wsA1, ciphertext(1), NONCE],
    )

    const { rows } = await db.as(
      USER_A,
      `select field_name, octet_length(ciphertext) as bytes
         from public.cloaked_fields where subject_type = 'contact' and subject_id = $1`,
      [id],
    )
    expect(rows).toEqual([{ field_name: 'name', bytes: 24 }])
  })

  it('lets a group label be cloaked too', async () => {
    // "Therapy", "Clients", "AA" — the list of group labels is a sketch of someone's life,
    // which is why groups got their own subject type rather than a text column.
    const id = await makeGroup(USER_A, wsA1)
    await db.as(
      USER_A,
      `insert into public.cloaked_fields
         (subject_type, subject_id, workspace_id, field_name, ciphertext, nonce, alg, key_version)
       values ('contact_group', $1, $2, 'label', decode($3,'hex'), decode($4,'hex'),
               'aes-256-gcm-v1', 1)`,
      [id, wsA1, ciphertext(2), NONCE],
    )
    const { rows } = await db.as(
      USER_A,
      `select count(*)::int as n from public.cloaked_fields
        where subject_type = 'contact_group' and subject_id = $1`,
      [id],
    )
    expect(rows).toEqual([{ n: 1 }])
  })

  it('hides one user’s contacts from another entirely', async () => {
    const mine = await makeContact(USER_A, wsA1)
    const { rows } = await db.as(USER_B, 'select id from public.contacts where id = $1', [mine])
    expect(rows).toEqual([])
  })

  it('refuses to let a user file a contact into a workspace they do not own', async () => {
    await expect(
      db.as(USER_B, 'insert into public.contacts (workspace_id) values ($1) returning id', [wsA1]),
    ).rejects.toThrow()
  })

  it('will not put a contact from one workspace into a group from another', async () => {
    // THE TEST THIS TABLE EXISTS FOR. Both rows belong to user A, so `is_workspace_member`
    // is satisfied for both and RLS raises no objection — the policy is about who owns a
    // row, not about whether two rows belong together. Only the composite foreign key can
    // see that this membership crosses an identity boundary the spec treats as absolute.
    const contact = await makeContact(USER_A, wsA1)
    const group = await makeGroup(USER_A, wsA2)

    await expect(
      db.as(
        USER_A,
        `insert into public.contact_group_members (group_id, contact_id, workspace_id)
         values ($1, $2, $3)`,
        [group, contact, wsA2],
      ),
    ).rejects.toThrow()

    // And the mirror image, in case only one of the two keys was wired up.
    await expect(
      db.as(
        USER_A,
        `insert into public.contact_group_members (group_id, contact_id, workspace_id)
         values ($1, $2, $3)`,
        [group, contact, wsA1],
      ),
    ).rejects.toThrow()
  })

  it('accepts a membership when both sides share a workspace', async () => {
    // Proves the test above is not vacuous — that the insert fails for the crossing rather
    // than because the statement is malformed.
    const contact = await makeContact(USER_A, wsA1)
    const group = await makeGroup(USER_A, wsA1)
    await db.as(
      USER_A,
      `insert into public.contact_group_members (group_id, contact_id, workspace_id)
       values ($1, $2, $3)`,
      [group, contact, wsA1],
    )
    const { rows } = await db.as(
      USER_A,
      'select count(*)::int as n from public.contact_group_members where group_id = $1',
      [group],
    )
    expect(rows).toEqual([{ n: 1 }])
  })

  it('removes memberships when the contact goes, without touching the group', async () => {
    const contact = await makeContact(USER_A, wsA1)
    const group = await makeGroup(USER_A, wsA1)
    await db.as(
      USER_A,
      `insert into public.contact_group_members (group_id, contact_id, workspace_id)
       values ($1, $2, $3)`,
      [group, contact, wsA1],
    )
    await db.as(USER_A, 'delete from public.contacts where id = $1', [contact])

    const members = await db.as(
      USER_A,
      'select count(*)::int as n from public.contact_group_members where group_id = $1',
      [group],
    )
    expect(members.rows).toEqual([{ n: 0 }])

    const groups = await db.as(
      USER_A,
      'select count(*)::int as n from public.contact_groups where id = $1',
      [group],
    )
    expect(groups.rows).toEqual([{ n: 1 }])
  })

  it('carries a group priority, because D8 breaks ties by it', async () => {
    const id = await makeGroup(USER_A, wsA1, 10)
    const { rows } = await db.as(
      USER_A,
      'select priority from public.contact_groups where id = $1',
      [id],
    )
    expect(rows).toEqual([{ priority: 10 }])
  })

  it('is unreachable without a session', async () => {
    await expect(db.asUnauthenticated('select id from public.contacts', [])).rejects.toThrow()
  })

  it('isolates the two address books in both directions', async () => {
    // Both directions, and B's side is seeded first: a one-way check passes trivially when
    // the other user simply has no rows, which is a way of testing nothing.
    const theirs = await makeContact(USER_B, wsB)
    await makeGroup(USER_B, wsB)

    const bSees = await db.as(
      USER_B,
      `select (select count(*)::int from public.contacts)       as contacts,
              (select count(*)::int from public.contact_groups) as groups`,
      [],
    )
    expect(bSees.rows).toEqual([{ contacts: 1, groups: 1 }])

    const aSeesTheirs = await db.as(USER_A, 'select id from public.contacts where id = $1', [
      theirs,
    ])
    expect(aSeesTheirs.rows).toEqual([])

    // A owns two workspaces and has made several contacts above; none of them are B's.
    const aSees = await db.as(
      USER_A,
      'select count(*)::int as n from public.contacts where workspace_id = $1',
      [wsB],
    )
    expect(aSees.rows).toEqual([{ n: 0 }])
  })
})
