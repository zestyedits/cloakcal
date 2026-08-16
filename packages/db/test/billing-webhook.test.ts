import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { USER_A, USER_B, createTestDb, type TestDb } from './harness.js'
import {
  CLAIM_EVENT,
  LOCK_BY_CUSTOMER,
  LOCK_BY_WORKSPACE,
  UPSERT_SUBSCRIPTION,
  UUID,
} from '../src/billing-queries.js'

/**
 * THE EXACT STATEMENTS THE WEBHOOK ISSUES, run AS `billing_writer`, with RLS enforced.
 *
 * The statements are imported rather than retyped, which is the whole point of
 * `src/billing-queries.ts` existing as a zero-import leaf module. A test that proves a
 * statement nothing runs is worse than no test: it reports green about a shape that has
 * drifted. Same argument `packages/policy`'s shared vectors make for the redaction engine.
 *
 * `billing-writer.test.ts` proves what the ROLE can reach. This proves what the HANDLER'S
 * SEQUENCE does, and in particular the two things the handler's design turns on: that a
 * rollback un-claims an event id, and that the row lock is a privilege this role actually has.
 *
 * WHAT PGLITE CANNOT SEE, stated so nobody mistakes green here for green in production: the
 * pooler username convention for a custom role, the password, TLS, `prepare: false` under
 * concurrency, and whether Supavisor accepts `billing_writer.<ref>` at all. Those need one
 * `psql` command against the live project, and CLAUDE.md says so.
 */
describe('the webhook statements', () => {
  let db: TestDb
  let wsA: string
  let wsB: string

  const rowFor = async (workspace: string): Promise<Record<string, unknown> | undefined> => {
    const { rows } = await db.raw('select * from public.subscriptions where workspace_id = $1', [
      workspace,
    ])
    return rows[0] as Record<string, unknown> | undefined
  }

  beforeAll(async () => {
    db = await createTestDb()
    await db.createUser(USER_A, 'a@example.test')
    await db.createUser(USER_B, 'b@example.test')
    const a = await db.as(USER_A, 'insert into public.workspaces (owner_id) values ($1) returning id', [USER_A])
    const b = await db.as(USER_B, 'insert into public.workspaces (owner_id) values ($1) returning id', [USER_B])
    wsA = a.rows[0]!['id'] as string
    wsB = b.rows[0]!['id'] as string
  })

  afterAll(async () => {
    await db.close()
  })

  describe('claiming an event', () => {
    it('returns the id the first time and nothing the second', async () => {
      const first = await db.asRole('billing_writer', CLAIM_EVENT, [
        'evt_claim_1',
        'customer.subscription.updated',
        1_700_000_000,
      ])
      expect(first.rows).toHaveLength(1)

      const second = await db.asRole('billing_writer', CLAIM_EVENT, [
        'evt_claim_1',
        'customer.subscription.updated',
        1_700_000_000,
      ])
      // Zero rows, NOT an exception. `on conflict do nothing` rather than catching the unique
      // violation, because a violation aborts the whole transaction and the handler would
      // have to unwind and reopen it, losing the row lock it took.
      expect(second.rows).toHaveLength(0)
    })

    it('records the provider clock rather than ours', async () => {
      await db.asRole('billing_writer', CLAIM_EVENT, ['evt_clock', 'x', 1_700_000_000])
      const { rows } = await db.raw(
        `select to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') as at
         from public.billing_events where event_id = 'evt_clock'`,
      )
      // Asked as TEXT, because PGlite parses a timestamp using the HOST timezone and this
      // repo has been bitten by that before. `occurred_at` is the provider's clock, which is
      // what makes out-of-order delivery diagnosable at all.
      expect(rows[0]?.['at']).toBe('2023-11-14T22:13:20')
    })

    /**
     * THE ASSERTION THE WHOLE IDEMPOTENCY DESIGN RESTS ON.
     *
     * The claim shares the transaction with the write. If it committed separately and the
     * write then failed, Stripe's retry would find the id present, conclude the work was
     * already done, and the plan would never land — an event swallowed by its own idempotency
     * guard, with no error anywhere and an account that paid sitting on Free.
     */
    it('un-claims an event id when the transaction rolls back', async () => {
      await expect(
        db.asRoleTransaction('billing_writer', async (tx) => {
          const claimed = await tx(CLAIM_EVENT, ['evt_rollback', 'x', 1_700_000_000])
          expect(claimed.rows).toHaveLength(1)
          // Standing in for whatever actually fails in the handler: Stripe timing out inside
          // the open transaction, the upsert hitting a constraint, the pooler dropping.
          await tx('select 1 / 0')
        }),
      ).rejects.toThrow()

      const { rows } = await db.raw(
        "select event_id from public.billing_events where event_id = 'evt_rollback'",
      )
      expect(rows).toHaveLength(0)

      // And the retry succeeds, which is the half that makes the rollback useful rather than
      // merely tidy.
      const retry = await db.asRole('billing_writer', CLAIM_EVENT, [
        'evt_rollback',
        'x',
        1_700_000_000,
      ])
      expect(retry.rows).toHaveLength(1)
    })
  })

  describe('resolving a workspace', () => {
    it('creates the first row from a workspace id the session supplied', async () => {
      await db.asRole('billing_writer', UPSERT_SUBSCRIPTION, [
        wsA,
        'pro',
        'cus_A',
        'sub_A',
        'active',
        '2026-09-16T00:00:00Z',
        false,
      ])
      const row = await rowFor(wsA)
      expect(row?.['plan']).toBe('pro')
      expect(row?.['provider_customer_id']).toBe('cus_A')
      expect(row?.['cancel_at_period_end']).toBe(false)
    })

    it('finds the workspace again from the customer id alone', async () => {
      // The role cannot read `workspaces` at all, so this table IS the mapping. ADR 0007
      // spends a page on why widening the role is the wrong fix.
      const { rows } = await db.asRole('billing_writer', LOCK_BY_CUSTOMER, ['cus_A'])
      expect(rows[0]?.['workspace_id']).toBe(wsA)
    })

    /**
     * `select … for update` is a PRIVILEGE question, not only a syntax one, and the handler
     * takes this lock BEFORE its Stripe call so two concurrent deliveries cannot each read
     * stale state and let the slower one's older snapshot win. Worth proving rather than
     * assuming: a role with SELECT but not UPDATE cannot lock a row for update.
     */
    it('can take the row lock the handler depends on', async () => {
      const byWorkspace = await db.asRole('billing_writer', LOCK_BY_WORKSPACE, [wsA])
      expect(byWorkspace.rows).toHaveLength(1)
    })

    it('returns nothing for a customer it has never seen, rather than erroring', async () => {
      // The handler treats this as "record, commit, 200, log": every branch re-fetches from
      // the API, so checkout.session.completed creates the row whenever it arrives. A 5xx
      // would burn retries on an event that cannot succeed until its sibling lands.
      const { rows } = await db.asRole('billing_writer', LOCK_BY_CUSTOMER, ['cus_nobody'])
      expect(rows).toHaveLength(0)
    })
  })

  describe('writing the plan', () => {
    it('upserts a returning customer onto their existing row', async () => {
      await db.asRole('billing_writer', UPSERT_SUBSCRIPTION, [
        wsA,
        'free',
        'cus_A',
        'sub_A2',
        'canceled',
        null,
        true,
      ])
      const row = await rowFor(wsA)
      expect(row?.['plan']).toBe('free')
      expect(row?.['provider_subscription_id']).toBe('sub_A2')
      expect(row?.['cancel_at_period_end']).toBe(true)
      // A cancellation is an UPDATE, never a DELETE. The row survives because it holds the
      // customer id the next event will resolve through, and 0028 grants no DELETE at all.
      expect(row?.['provider_customer_id']).toBe('cus_A')
    })

    it('accepts a null period end without inventing one', async () => {
      const row = await rowFor(wsA)
      expect(row?.['current_period_end']).toBeNull()
    })

    it('refuses a plan the check constraint does not know', async () => {
      await expect(
        db.asRole('billing_writer', UPSERT_SUBSCRIPTION, [
          wsB,
          'enterprise',
          'cus_B',
          'sub_B',
          'active',
          null,
          false,
        ]),
      ).rejects.toThrow(/subscriptions_plan_known|violates check constraint/)
    })

    /**
     * `provider_customer_id` IS UNIQUE (0028), so two workspaces cannot claim one Stripe
     * customer. That is what stops a bug in the mapping from quietly giving one payment to two
     * accounts — it fails loudly instead, and the webhook's 500 makes Stripe retry.
     */
    it('refuses to give one customer to two workspaces', async () => {
      await expect(
        db.asRole('billing_writer', UPSERT_SUBSCRIPTION, [
          wsB,
          'pro',
          'cus_A',
          'sub_other',
          'active',
          null,
          false,
        ]),
      ).rejects.toThrow(/unique|duplicate key/i)
    })

    /**
     * A well-formed WRONG workspace id is the one integrity risk `using (true)` leaves
     * standing, and the foreign key is the only thing that catches it — which it does only
     * when the id belongs to no workspace at all. For an id that belongs to SOMEBODY ELSE'S
     * workspace there is no database defence, which is exactly why the handler validates
     * `client_reference_id` and why it may only ever come from an authenticated session.
     */
    it('refuses a workspace that does not exist', async () => {
      await expect(
        db.asRole('billing_writer', UPSERT_SUBSCRIPTION, [
          '00000000-0000-4000-8000-000000000000',
          'pro',
          'cus_ghost',
          'sub_ghost',
          'active',
          null,
          false,
        ]),
      ).rejects.toThrow(/foreign key|violates/i)
    })
  })

  describe('the uuid guard', () => {
    it('accepts a real workspace id', () => {
      expect(UUID.test(wsA)).toBe(true)
    })

    it('refuses everything a payload could smuggle in its place', () => {
      for (const value of [
        '',
        'not-a-uuid',
        `${wsA} `,
        `${wsA}'; drop table public.subscriptions; --`,
        '00000000-0000-0000-0000-000000000000', // version nibble 0
        'ffffffff-ffff-ffff-ffff-ffffffffffff', // version nibble f
      ]) {
        expect(UUID.test(value), `${value} must not pass`).toBe(false)
      }
    })
  })
})
