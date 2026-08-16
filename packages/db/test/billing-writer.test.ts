import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { USER_A, USER_B, createTestDb, type TestDb } from './harness.js'

/**
 * `billing_writer` (0028) — what the webhook role can actually do, at runtime.
 *
 * subscription.test.ts pins the SHAPE: which policies exist, which verbs are granted, that
 * the role cannot log in yet. This file pins the BEHAVIOUR, as the role, with RLS enforced —
 * because a grant and a policy can both look right and still combine into something that
 * refuses every write, and the superuser (which `db.raw` uses) bypasses RLS and would prove
 * nothing either way.
 *
 * The claim under test is ADR 0007's: this role can maintain one fact on one table, and is
 * incapable of reaching anything else — including the account table it would need to resolve
 * a customer to a workspace, which is why that mapping lives in `subscriptions` itself.
 */
describe('the billing writer role', () => {
  let db: TestDb
  let wsA: string
  let wsB: string

  const planOf = async (workspace: string): Promise<unknown> => {
    const { rows } = await db.raw('select plan from public.subscriptions where workspace_id = $1', [
      workspace,
    ])
    return rows[0]?.['plan']
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

  it('writes a plan for a workspace it was handed', async () => {
    await db.asRole(
      'billing_writer',
      `insert into public.subscriptions
         (workspace_id, plan, provider_customer_id, provider_subscription_id, provider_status)
       values ($1, 'pro', 'cus_test_a', 'sub_test_a', 'active')`,
      [wsA],
    )
    expect(await planOf(wsA)).toBe('pro')
  })

  it('amends the row it wrote, which is how a cancellation lands', async () => {
    // A cancellation is an UPDATE to free, never a DELETE. The row survives because it holds
    // the provider ids that every later webhook resolves through.
    await db.asRole(
      'billing_writer',
      `update public.subscriptions
          set plan = 'free', provider_status = 'canceled', cancel_at_period_end = true
        where provider_customer_id = 'cus_test_a'`,
    )
    expect(await planOf(wsA)).toBe('free')

    const { rows } = await db.raw(
      `select provider_customer_id from public.subscriptions where workspace_id = $1`,
      [wsA],
    )
    expect(rows[0]?.['provider_customer_id']).toBe('cus_test_a')
  })

  it('resolves a customer to a workspace from subscriptions alone', async () => {
    // ADR 0007's mapping, exercised as the role. This is the ONLY lookup the webhook has, and
    // the test below proves it is the only one it could have.
    const { rows } = await db.asRole(
      'billing_writer',
      `select workspace_id from public.subscriptions where provider_customer_id = $1`,
      ['cus_test_a'],
    )
    expect(rows[0]?.['workspace_id']).toBe(wsA)
  })

  it('CANNOT read the account table, so it cannot widen its own lookup', async () => {
    // The claim ADR 0007 spends a paragraph defending. The natural fix when the mapping gets
    // awkward is to let this role read `workspaces`; this is what fails when someone does.
    await expect(
      db.asRole('billing_writer', 'select id from public.workspaces'),
    ).rejects.toThrow(/permission denied/i)
  })

  it('cannot reach an event or a sealed field', async () => {
    await expect(
      db.asRole('billing_writer', 'select id from public.events'),
    ).rejects.toThrow(/permission denied/i)
    await expect(
      db.asRole('billing_writer', 'select ciphertext from public.cloaked_fields'),
    ).rejects.toThrow(/permission denied/i)
  })

  it('cannot delete a billing row, so it cannot cover its tracks', async () => {
    await expect(
      db.asRole('billing_writer', 'delete from public.subscriptions'),
    ).rejects.toThrow(/permission denied/i)
    expect(await planOf(wsA)).toBe('free')
  })

  it('records an event id once, and a replay violates the primary key', async () => {
    // The idempotency mechanism, which is the whole reason billing_events exists. Webhooks
    // are at-least-once: a timeout after a successful write is indistinguishable from a
    // failure, and replaying `subscription.deleted` after `created` would downgrade someone
    // who is paying. The handler inserts FIRST and treats this violation as "already done".
    await db.asRole(
      'billing_writer',
      `insert into public.billing_events (event_id, event_type, occurred_at)
       values ('evt_1', 'customer.subscription.updated', now())`,
    )

    await expect(
      db.asRole(
        'billing_writer',
        `insert into public.billing_events (event_id, event_type, occurred_at)
         values ('evt_1', 'customer.subscription.updated', now())`,
      ),
    ).rejects.toThrow(/billing_events_pkey|duplicate key/i)
  })

  it('keeps the account holder unable to write their own plan', async () => {
    // 0024's guarantee, re-asserted from this side: adding a writer role must not have handed
    // the user one. Their workspace, their row, their session, still denied.
    //
    // It is a hard 42501, NOT an RLS filter down to zero rows — which is the STRONGER of the
    // two independent gates 0024 built, and worth asserting as the specific thing it is. The
    // missing UPDATE grant refuses the statement before any policy is consulted, so this
    // stays red even if someone later adds a permissive policy. Asserting a zero-row result
    // instead would have passed against a table that had quietly grown a write policy.
    await expect(
      db.as(USER_A, `update public.subscriptions set plan = 'pro' where workspace_id = $1`, [wsA]),
    ).rejects.toThrow(/permission denied/i)
    expect(await planOf(wsA)).toBe('free')

    await expect(
      db.as(USER_A, `insert into public.subscriptions (workspace_id, plan) values ($1, 'pro')`, [
        wsB,
      ]),
    ).rejects.toThrow(/row-level security|permission denied|duplicate/i)
  })

  it('is invisible to anon and to a signed-in user alike on billing_events', async () => {
    // The events table holds no customer data, but it is still a record of when someone's
    // billing changed, and nobody outside the writer has any business reading it.
    await expect(
      db.asUnauthenticated('select event_id from public.billing_events'),
    ).rejects.toThrow(/permission denied/i)
    await expect(
      db.as(USER_A, 'select event_id from public.billing_events'),
    ).rejects.toThrow(/permission denied/i)
  })

  it("cannot see another workspace's plan through a join it does not have", async () => {
    // `using (true)` means this role CAN read every subscriptions row — stated plainly in the
    // migration and unavoidable for a sessionless webhook. What it cannot do is turn a row
    // into an identity: no email, no owner, no workspace record. This test documents the
    // actual boundary rather than implying a tighter one.
    await db.asRole(
      'billing_writer',
      `insert into public.subscriptions (workspace_id, plan, provider_customer_id)
       values ($1, 'pro', 'cus_test_b')`,
      [wsB],
    )
    const { rows } = await db.asRole('billing_writer', 'select workspace_id from public.subscriptions')
    expect(rows).toHaveLength(2)

    await expect(
      db.asRole('billing_writer', 'select email from auth.users'),
    ).rejects.toThrow(/permission denied/i)
  })
})
