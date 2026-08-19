import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { USER_A, USER_B, createTestDb, type TestDb } from './harness.js'

/**
 * 0031 — restore, uncancel and purge.
 *
 * trash-event.test.ts already asserts that trashing is REVERSIBLE ("if either were deleted
 * here the trash would be a purge wearing a friendly name, and the 'Undo' this enables could
 * never be built"). This is that undo, plus the one action that genuinely destroys.
 *
 * Four things are load-bearing here and none of them is the happy path:
 *
 *   1. THE `+ 1`. `p_deleted_from_version` is the version the client held when it deleted, and
 *      the function checks `version = that + 1`. That is only correct while trash and cancel
 *      each bump by exactly one, so this file pins the increment directly. Without that pin a
 *      future change to either would make every legitimate undo fail as a version conflict —
 *      an arithmetic change presenting as a concurrency bug.
 *
 *   2. PURGE ACTUALLY ERASES THE CIPHERTEXT. `cloaked_fields` has no foreign key to `events`,
 *      so no cascade touches it. A purge that dropped the row and left the ciphertext would
 *      pass every other assertion in this repo while the product claimed permanent deletion.
 *
 *   3. THE MOVED-EXCEPTION CONSTRAINT. `replacement_event_id` is `on delete set null` and the
 *      table checks `(kind = 'moved') = (replacement_event_id is not null)`, so purging a
 *      split-off occurrence would violate it. The function converts the exception to
 *      'cancelled' instead, which keeps the occurrence subtracted rather than resurrecting it.
 *
 *   4. THE AUDIT ROW SURVIVES A PURGE, because the privacy policy promises exactly that.
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
    $7::timestamp, false, null, null, $8::text, 'busy', $9::jsonb
  ) as id`

const TRASH = `select public.trash_cloaked_event($1::uuid, $2::integer)`
const RESTORE = `select public.restore_cloaked_event($1::uuid, $2::integer)`
const PURGE = `select public.purge_cloaked_event($1::uuid)`
const CANCEL = `select public.cancel_occurrence($1::uuid, $2::integer, $3::text)`
const UNCANCEL = `select public.uncancel_occurrence($1::uuid, $2::text)`

describe('0031 restore / uncancel / purge', () => {
  let db: TestDb
  let workspaceA: string
  let calendarA: string
  let seq = 0

  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

  /** Create an event owned by user A, optionally repeating, and hand back its id. */
  const seed = async (rrule: string | null = null) => {
    seq += 1
    const id = uuid(seq)
    await db.as(USER_A, CREATE, [
      id,
      workspaceA,
      calendarA,
      'America/New_York',
      '2026-05-19T13:00:00Z',
      '2026-05-19T13:30:00Z',
      '2026-05-19 09:00:00',
      rrule,
      JSON.stringify([field('title', seq), field('notes', seq)]),
    ])
    return id
  }

  const versionOf = async (id: string) => {
    const row = await db.as(USER_A, 'select version from public.events where id = $1', [id])
    return (row.rows[0] as { version: number } | undefined)?.version
  }

  const lifecycleOf = async (id: string) => {
    const row = await db.as(USER_A, 'select lifecycle from public.events where id = $1', [id])
    return (row.rows[0] as { lifecycle: string } | undefined)?.lifecycle
  }

  const fieldCount = async (id: string) => {
    const row = await db.as(
      USER_A,
      `select count(*)::int as n from public.cloaked_fields
        where subject_type = 'event' and subject_id = $1`,
      [id],
    )
    return (row.rows[0] as { n: number }).n
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

  /*
   * The invariant `p_deleted_from_version + 1` is built on. Asserted directly rather than
   * inferred from a passing restore, because a restore that passes for the wrong reason looks
   * identical to one that passes for the right one.
   */
  describe('the delete RPCs bump version by exactly one', () => {
    it('trash increments once', async () => {
      const id = await seed()
      const before = await versionOf(id)
      await db.as(USER_A, TRASH, [id, before])
      expect(await versionOf(id)).toBe((before ?? 0) + 1)
    })

    it('cancel_occurrence increments once', async () => {
      const id = await seed('FREQ=WEEKLY')
      const before = await versionOf(id)
      await db.as(USER_A, CANCEL, [id, before, '2026-05-26T09:00:00'])
      expect(await versionOf(id)).toBe((before ?? 0) + 1)
    })
  })

  describe('restore_cloaked_event', () => {
    it('brings a trashed event back and clears trashed_at', async () => {
      const id = await seed()
      const deletedFrom = await versionOf(id)
      await db.as(USER_A, TRASH, [id, deletedFrom])
      expect(await lifecycleOf(id)).toBe('trashed')

      await db.as(USER_A, RESTORE, [id, deletedFrom])

      expect(await lifecycleOf(id)).toBe('active')
      const row = await db.as(USER_A, 'select trashed_at from public.events where id = $1', [id])
      expect((row.rows[0] as { trashed_at: unknown }).trashed_at).toBeNull()
    })

    it('leaves the ciphertext exactly where it was', async () => {
      const id = await seed()
      const deletedFrom = await versionOf(id)
      await db.as(USER_A, TRASH, [id, deletedFrom])
      // The whole reason a trash is reversible: 0008 never removed these.
      expect(await fieldCount(id)).toBe(2)
      await db.as(USER_A, RESTORE, [id, deletedFrom])
      expect(await fieldCount(id)).toBe(2)
    })

    it('refuses an event that is not trashed', async () => {
      const id = await seed()
      const version = await versionOf(id)
      await expect(db.as(USER_A, RESTORE, [id, (version ?? 1) - 1])).rejects.toThrow(/not trashed/i)
    })

    it('refuses when the row moved on after the delete', async () => {
      const id = await seed()
      const deletedFrom = await versionOf(id)
      await db.as(USER_A, TRASH, [id, deletedFrom])
      // Somebody else restored it and trashed it again: version is now deletedFrom + 3.
      await db.as(USER_A, RESTORE, [id, deletedFrom])
      const again = await versionOf(id)
      await db.as(USER_A, TRASH, [id, again])

      await expect(db.as(USER_A, RESTORE, [id, deletedFrom])).rejects.toThrow(
        /changed after it was deleted/i,
      )
    })

    /*
     * RLS, not a permission check in the function. User B cannot SEE the row, so the select
     * finds nothing and the failure is "does not exist" — indistinguishable from a bad id,
     * which is the correct disclosure and the same answer every other RPC here gives.
     */
    it('will not restore another user event', async () => {
      const id = await seed()
      const deletedFrom = await versionOf(id)
      await db.as(USER_A, TRASH, [id, deletedFrom])

      await expect(db.as(USER_B, RESTORE, [id, deletedFrom])).rejects.toThrow(/does not exist/i)
      expect(await lifecycleOf(id)).toBe('trashed')
    })
  })

  describe('uncancel_occurrence', () => {
    it('removes the cancelled exception', async () => {
      const id = await seed('FREQ=WEEKLY')
      const deletedFrom = await versionOf(id)
      await db.as(USER_A, CANCEL, [id, deletedFrom, '2026-05-26T09:00:00'])

      await db.as(USER_A, UNCANCEL, [id, '2026-05-26T09:00:00'])

      const rows = await db.as(
        USER_A,
        'select count(*)::int as n from public.recurrence_exceptions where series_id = $1',
        [id],
      )
      expect((rows.rows[0] as { n: number }).n).toBe(0)
    })

    it('refuses an occurrence that is not cancelled', async () => {
      const id = await seed('FREQ=WEEKLY')
      await expect(db.as(USER_A, UNCANCEL, [id, '2026-06-02T09:00:00'])).rejects.toThrow(
        /not cancelled/i,
      )
    })

    it('rejects a non-canonical wall time rather than casting it', async () => {
      const id = await seed('FREQ=WEEKLY')
      const deletedFrom = await versionOf(id)
      await db.as(USER_A, CANCEL, [id, deletedFrom, '2026-05-26T09:00:00'])
      // A zoned string would silently parse to a different instant and un-cancel the wrong day.
      await expect(db.as(USER_A, UNCANCEL, [id, '2026-05-26T09:00:00-04:00'])).rejects.toThrow(
        /YYYY-MM-DDTHH:MM:SS/,
      )
    })

    /*
     * THE ABSENT VERSION GUARD, asserted rather than left as an omission someone tidies
     * back in.
     *
     * Cancelling a second occurrence bumps the series version, so a guard keyed to the
     * version at the time of the FIRST cancel would now reject it -- permanently, from the
     * Trash page, which can only ever see the current value. Un-cancelling clobbers
     * nothing, so the honest answer is no guard at all. The same call 0017 makes for
     * visibility rules.
     */
    it('still restores an occurrence after the series has moved on', async () => {
      const id = await seed('FREQ=WEEKLY')
      const first = await versionOf(id)
      await db.as(USER_A, CANCEL, [id, first, '2026-05-26T09:00:00'])
      await db.as(USER_A, CANCEL, [id, (first ?? 1) + 1, '2026-06-02T09:00:00'])

      await db.as(USER_A, UNCANCEL, [id, '2026-05-26T09:00:00'])

      const rows = await db.as(
        USER_A,
        `select occurrence_local::text as at from public.recurrence_exceptions
          where series_id = $1`,
        [id],
      )
      // The second cancellation is untouched; only the one asked for came back.
      expect(rows.rows).toHaveLength(1)
      expect((rows.rows[0] as { at: string }).at).toContain('2026-06-02')
    })

    it('will not uncancel in another user workspace', async () => {
      const id = await seed('FREQ=WEEKLY')
      const deletedFrom = await versionOf(id)
      await db.as(USER_A, CANCEL, [id, deletedFrom, '2026-05-26T09:00:00'])

      await expect(db.as(USER_B, UNCANCEL, [id, '2026-05-26T09:00:00'])).rejects.toThrow(
        /does not exist/i,
      )
    })
  })

  describe('purge_cloaked_event', () => {
    it('refuses anything that is not already trashed', async () => {
      const id = await seed()
      await expect(db.as(USER_A, PURGE, [id])).rejects.toThrow(/cannot be permanently deleted/i)
      expect(await lifecycleOf(id)).toBe('active')
    })

    /*
     * THE ASSERTION THIS FILE EXISTS FOR. cloaked_fields has no FK to events, so nothing in
     * the delete or in any cascade removes the ciphertext. If the explicit delete in 0031 is
     * ever dropped in a refactor, every other test here still passes and the product keeps
     * telling users their content was permanently removed.
     */
    it('erases the ciphertext, which no cascade would do', async () => {
      const id = await seed()
      const version = await versionOf(id)
      await db.as(USER_A, TRASH, [id, version])
      expect(await fieldCount(id)).toBe(2)

      await db.as(USER_A, PURGE, [id])

      expect(await fieldCount(id)).toBe(0)
      expect(await lifecycleOf(id)).toBeUndefined()
    })

    it('takes event-scoped visibility rules with it, by cascade', async () => {
      const id = await seed()
      const contact = await db.as(
        USER_A,
        'insert into public.contacts (workspace_id) values ($1) returning id',
        [workspaceA],
      )
      await db.as(
        USER_A,
        `insert into public.visibility_rules
           (workspace_id, scope, event_id, audience, audience_ref, time_vis)
         values ($1, 'event', $2, 'individual', $3, 'busy')`,
        [workspaceA, id, (contact.rows[0] as { id: string }).id],
      )

      const version = await versionOf(id)
      await db.as(USER_A, TRASH, [id, version])
      await db.as(USER_A, PURGE, [id])

      const rules = await db.as(
        USER_A,
        'select count(*)::int as n from public.visibility_rules where event_id = $1',
        [id],
      )
      expect((rules.rows[0] as { n: number }).n).toBe(0)
    })

    /*
     * The constraint trap. `replacement_event_id` is `on delete set null` and the table checks
     * `(kind = 'moved') = (replacement_event_id is not null)`, so a naive delete raises a check
     * violation. Converting the row to 'cancelled' is what keeps the occurrence subtracted —
     * deleting the exception instead would make the purged occurrence REAPPEAR in its series.
     */
    it('converts a moved exception to cancelled rather than violating its check', async () => {
      const series = await seed('FREQ=WEEKLY')
      const detached = await seed()
      await db.as(
        USER_A,
        `insert into public.recurrence_exceptions
           (series_id, workspace_id, occurrence_local, kind, replacement_event_id)
         values ($1, $2, $3::timestamp, 'moved', $4)`,
        [series, workspaceA, '2026-05-26 09:00:00', detached],
      )

      const version = await versionOf(detached)
      await db.as(USER_A, TRASH, [detached, version])
      await db.as(USER_A, PURGE, [detached])

      const row = await db.as(
        USER_A,
        `select kind, replacement_event_id from public.recurrence_exceptions
          where series_id = $1`,
        [series],
      )
      const exception = row.rows[0] as { kind: string; replacement_event_id: string | null }
      expect(exception.kind).toBe('cancelled')
      expect(exception.replacement_event_id).toBeNull()
    })

    /* The privacy policy promises the audit record survives, so it is asserted, not assumed. */
    it('leaves the append-only audit trail behind', async () => {
      const id = await seed()
      const version = await versionOf(id)
      await db.as(USER_A, TRASH, [id, version])
      await db.as(USER_A, PURGE, [id])

      const rows = await db.as(
        USER_A,
        `select action, detail::text as detail from public.audit_log
          where subject_id = $1 order by id`,
        [id],
      )
      const actions = rows.rows.map((r) => (r as { action: string }).action)
      expect(actions).toContain('event.purged')
      // And it names no content — the whole reason an audit row is allowed to outlive a purge.
      for (const row of rows.rows) {
        expect((row as { detail: string }).detail).not.toMatch(/title|notes|location/i)
      }
    })

    it('will not purge another user event', async () => {
      const id = await seed()
      const version = await versionOf(id)
      await db.as(USER_A, TRASH, [id, version])

      await expect(db.as(USER_B, PURGE, [id])).rejects.toThrow(/does not exist/i)
      expect(await fieldCount(id)).toBe(2)
    })
  })
})
