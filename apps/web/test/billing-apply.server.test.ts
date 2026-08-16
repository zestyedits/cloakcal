import { afterEach, describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import { CLAIM_EVENT, LOCK_BY_CUSTOMER, UPSERT_SUBSCRIPTION } from '@cloakcal/db/billing-queries'
import type { BillingConfig } from '../src/server/billing/config'

/**
 * `applyBillingEvent`, exercised as a SEQUENCE.
 *
 * Everything else that touches this function checks a different thing and neither checks this
 * one. `billing-routes.server.test.ts` reads source text and asserts on `indexOf`.
 * `packages/db/test/billing-webhook.test.ts` runs each statement through `db.asRole`, which is
 * autocommit — so the ordering the whole design rests on (claim, lock, fetch, upsert, in ONE
 * transaction) was executed nowhere.
 *
 * That left the branches carrying the money decisions untested: the duplicate short-circuit,
 * the uuid rejection, the unknown-customer path, WHICH branches commit the claim, the unique
 * violation that would otherwise poison a Stripe retry queue for days, and `periodEnd`'s
 * items-rather-than-subscription read — which `apply.ts`'s own header calls out as silent in
 * both directions.
 *
 * The database and Stripe are both mocked. That is the point: this file is about control flow,
 * and the statements themselves are proved against a real Postgres in `packages/db`.
 */

const CONFIG: BillingConfig = {
  secretKey: 'sk_test_x',
  webhookSecret: 'whsec_x',
  databaseUrl: 'postgresql://billing_writer.ref:pw@host:6543/postgres',
  priceMonthly: 'price_monthly',
  priceAnnual: 'price_annual',
  portalConfigurationId: 'bpc_x',
  mode: 'test',
}

const WORKSPACE = '11111111-1111-4111-8111-111111111111'

/** Every statement the transaction issued, in order, so the SEQUENCE can be asserted. */
let issued: { sql: string; params: unknown[] }[] = []
/** Queued answers, by statement. A missing entry answers with no rows. */
let answers: Map<string, unknown[]>
/** Statements that should throw instead of answering. */
let throwOn: Map<string, Error>
let committed: boolean
let retrieved: string[]
let subscription: Stripe.Subscription

/**
 * Stands in for postgres.js's transaction handle, which is a TAGGED TEMPLATE with an `unsafe`
 * method hanging off it. `apply.ts` only ever calls `tx.unsafe(text, params)`, because the
 * statements come from `@cloakcal/db/billing-queries` as plain strings so that the PGlite
 * tests can run the same ones.
 */
const tx = {
  unsafe: async (sql: string, params: unknown[] = []) => {
    issued.push({ sql, params })
    const failure = throwOn.get(sql)
    if (failure !== undefined) throw failure
    return answers.get(sql) ?? []
  },
}

vi.mock('../src/server/billing/db', () => ({
  billingDb: () => ({
    // Mirrors postgres.js: the callback runs, a throw rolls back and rethrows, falling off the
    // end commits. `packages/db` proves the real driver does this; here it is the harness.
    begin: async (fn: (t: typeof tx) => Promise<unknown>) => {
      committed = false
      const result = await fn(tx)
      committed = true
      return result
    },
  }),
}))

vi.mock('../src/server/billing/stripe', () => ({
  stripeClient: () => ({
    subscriptions: {
      retrieve: async (id: string) => {
        retrieved.push(id)
        // Recorded into the SAME sequence as the SQL, or "locks THEN asks Stripe" is two
        // separate facts rather than an ordering.
        issued.push({ sql: 'STRIPE_RETRIEVE', params: [id] })
        return subscription
      },
    },
  }),
}))

const { applyBillingEvent } = await import('../src/server/billing/apply')

function makeSubscription(over: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    cancel_at_period_end: false,
    items: {
      data: [
        {
          id: 'si_1',
          price: { id: 'price_monthly' },
          current_period_end: 1_772_000_000,
        },
      ],
    },
    ...over,
  } as unknown as Stripe.Subscription
}

function event(type: string, object: unknown, id = 'evt_1'): Stripe.Event {
  return { id, type, created: 1_700_000_000, data: { object } } as unknown as Stripe.Event
}

const checkout = (over: Record<string, unknown> = {}) =>
  event('checkout.session.completed', {
    mode: 'subscription',
    subscription: 'sub_1',
    client_reference_id: WORKSPACE,
    ...over,
  })


afterEach(() => {
  vi.clearAllMocks()
})

function reset() {
  issued = []
  answers = new Map([
    [CLAIM_EVENT, [{ event_id: 'evt_1' }]],
    [UPSERT_SUBSCRIPTION, [{ workspace_id: WORKSPACE, plan: 'pro' }]],
  ])
  throwOn = new Map()
  committed = false
  retrieved = []
  subscription = makeSubscription()
}

describe('the transaction sequence', () => {
  /**
   * THE ORDER IS THE DESIGN. Locking before the Stripe call is what stops two concurrent
   * deliveries each reading stale state and letting the slower one's older snapshot win; every
   * argument in `billing-queries.ts` depends on it, and until now nothing ran it.
   */
  it('claims, locks, THEN asks Stripe, then writes', async () => {
    reset()
    answers.set(LOCK_BY_CUSTOMER, [{ workspace_id: WORKSPACE }])

    const outcome = await applyBillingEvent(
      event('customer.subscription.updated', makeSubscription()),
      CONFIG,
    )

    expect(outcome).toEqual({ kind: 'applied', workspaceId: WORKSPACE, plan: 'pro' })
    expect(issued.map((i) => i.sql)).toEqual([
      CLAIM_EVENT,
      LOCK_BY_CUSTOMER,
      'STRIPE_RETRIEVE',
      UPSERT_SUBSCRIPTION,
    ])
    expect(retrieved).toEqual(['sub_1'])
    expect(committed).toBe(true)
  })

  it('short-circuits a duplicate without touching Stripe or writing anything', async () => {
    reset()
    answers.set(CLAIM_EVENT, []) // already applied

    const outcome = await applyBillingEvent(checkout(), CONFIG)

    expect(outcome).toEqual({ kind: 'duplicate' })
    expect(issued.map((i) => i.sql)).toEqual([CLAIM_EVENT])
    expect(retrieved).toEqual([])
    // Committed, so the claim stays claimed. Rolling back here would un-claim an id that a
    // previous delivery legitimately owns.
    expect(committed).toBe(true)
  })
})

describe('the checkout branch', () => {
  it('takes the workspace from client_reference_id and creates the row', async () => {
    reset()
    const outcome = await applyBillingEvent(checkout(), CONFIG)

    expect(outcome).toEqual({ kind: 'applied', workspaceId: WORKSPACE, plan: 'pro' })
    const upsert = issued.find((i) => i.sql === UPSERT_SUBSCRIPTION)
    expect(upsert?.params[0]).toBe(WORKSPACE)
    expect(upsert?.params[1]).toBe('pro')
    expect(upsert?.params[2]).toBe('cus_1')
  })

  /**
   * A WELL-FORMED WRONG ID WRITES A PLAN ONTO SOMEBODY ELSE'S ACCOUNT, which ADR 0007 names as
   * the single integrity risk `using (true)` leaves standing. The uuid guard is the only thing
   * between the two, and it had no test.
   */
  it('refuses anything that is not a uuid, without writing', async () => {
    for (const reference of [null, '', 'not-a-uuid', `${WORKSPACE} `, '../../etc']) {
      reset()
      const outcome = await applyBillingEvent(
        checkout({ client_reference_id: reference }),
        CONFIG,
      )
      expect(outcome.kind, String(reference)).toBe('ignored')
      expect(issued.map((i) => i.sql)).toEqual([CLAIM_EVENT])
      expect(retrieved).toEqual([])
    }
  })

  it('ignores a one-off payment, which this product does not sell', async () => {
    reset()
    const outcome = await applyBillingEvent(checkout({ mode: 'payment' }), CONFIG)
    expect(outcome).toEqual({ kind: 'ignored', reason: 'checkout mode payment' })
  })
})

describe('the subscription branch', () => {
  it('acknowledges an unknown customer rather than making Stripe retry forever', async () => {
    reset()
    answers.set(LOCK_BY_CUSTOMER, []) // no row for this customer

    const outcome = await applyBillingEvent(
      event('customer.subscription.deleted', makeSubscription()),
      CONFIG,
    )

    expect(outcome).toEqual({ kind: 'unknown-customer', customerId: 'cus_1' })
    // Committed, so the id is claimed and Stripe will not be asked again. A 5xx here would
    // burn retries on an event that cannot succeed until its sibling lands.
    expect(committed).toBe(true)
    expect(retrieved).toEqual([])
  })

  /**
   * An operator ticking `invoice.payment_failed` in the Stripe dashboard would previously hand
   * the blind cast an Invoice, `subscriptions.retrieve('in_…')` would throw, and Stripe would
   * retry a doomed event until it disabled the endpoint.
   */
  it('ignores an event type it has no handling for, instead of casting blindly', async () => {
    reset()
    const outcome = await applyBillingEvent(
      event('invoice.payment_failed', { id: 'in_1', customer: 'cus_1' }),
      CONFIG,
    )
    expect(outcome.kind).toBe('ignored')
    expect(retrieved).toEqual([])
  })
})

describe('an unregistered event type', () => {
  /**
   * IT MUST NOT REACH THE DATABASE AT ALL. `stripe listen` forwards every event on the
   * account, not the four the endpoint subscribes to, so one `stripe trigger` produced ten
   * irrelevant deliveries — and each one opened a pooler connection to claim an id nothing
   * would ever read. With `max: 1` they queued until `connect_timeout` fired and the
   * responses took thirty seconds. It also fills `billing_events`, which has no DELETE grant.
   */
  it('never opens a connection or claims an id', async () => {
    for (const type of [
      'plan.created',
      'price.created',
      'charge.succeeded',
      'payment_method.attached',
      'invoice.finalized',
    ]) {
      reset()
      const outcome = await applyBillingEvent(event(type, { id: 'x' }), CONFIG)
      expect(outcome.kind, type).toBe('ignored')
      // Not one statement, not even the claim.
      expect(issued, type).toEqual([])
      expect(retrieved, type).toEqual([])
    }
  })
})

describe('the plan decision', () => {
  it('grants Pro only for a healthy subscription', async () => {
    for (const [status, plan] of [
      ['active', 'pro'],
      ['trialing', 'pro'],
      ['past_due', 'free'],
      ['unpaid', 'free'],
      ['canceled', 'free'],
      ['incomplete', 'free'],
    ] as const) {
      reset()
      subscription = makeSubscription({ status } as Partial<Stripe.Subscription>)
      await applyBillingEvent(checkout(), CONFIG)
      const upsert = issued.find((i) => i.sql === UPSERT_SUBSCRIPTION)
      expect(upsert?.params[1], status).toBe(plan)
    }
  })
})

describe('the period end', () => {
  /**
   * `billing_mode: flexible` moved `current_period_end` OFF the Subscription and ONTO its
   * items. The failure is silent in both directions — optional in the SDK's types, nullable by
   * design in 0028 — so a wrong read stores null forever and the page says "renews —" for the
   * life of the account.
   */
  it('reads it off the item, not the subscription', async () => {
    reset()
    subscription = makeSubscription({
      // What a pre-2025 guide would have you read. It must be IGNORED.
      current_period_end: 999,
    } as Partial<Stripe.Subscription>)

    await applyBillingEvent(checkout(), CONFIG)
    const upsert = issued.find((i) => i.sql === UPSERT_SUBSCRIPTION)
    expect(upsert?.params[5]).toBe(new Date(1_772_000_000 * 1000).toISOString())
  })

  it('prefers the item priced at one of our own prices', async () => {
    reset()
    subscription = makeSubscription({
      items: {
        data: [
          { id: 'si_other', price: { id: 'price_someone_else' }, current_period_end: 1 },
          { id: 'si_ours', price: { id: 'price_annual' }, current_period_end: 1_772_000_000 },
        ],
      },
    } as unknown as Partial<Stripe.Subscription>)

    await applyBillingEvent(checkout(), CONFIG)
    const upsert = issued.find((i) => i.sql === UPSERT_SUBSCRIPTION)
    expect(upsert?.params[5]).toBe(new Date(1_772_000_000 * 1000).toISOString())
  })

  it('writes null rather than an invalid date when there is no item', async () => {
    reset()
    subscription = makeSubscription({ items: { data: [] } } as unknown as Partial<Stripe.Subscription>)
    await applyBillingEvent(checkout(), CONFIG)
    const upsert = issued.find((i) => i.sql === UPSERT_SUBSCRIPTION)
    expect(upsert?.params[5]).toBeNull()
  })
})

describe('a unique violation', () => {
  /**
   * THE POISON EVENT. The upsert is `on conflict (workspace_id)`, but 0028 also makes
   * `provider_customer_id` and `provider_subscription_id` UNIQUE — and a conflict on either
   * raises 23505, which that clause cannot catch.
   *
   * Left to throw, the transaction rolls back, the claim un-claims, the route 500s, and Stripe
   * retries the same doomed event until it DISABLES THE ENDPOINT. Which is the outcome the
   * webhook's own header calls the most silent failure in this design, arrived at by way of the
   * mechanism meant to prevent it.
   */
  it('is acknowledged rather than retried into an endpoint suspension', async () => {
    reset()
    const violation = Object.assign(new Error('duplicate key'), { code: '23505' })
    throwOn.set(UPSERT_SUBSCRIPTION, violation)

    const outcome = await applyBillingEvent(checkout(), CONFIG)

    expect(outcome).toEqual({
      kind: 'conflict',
      workspaceId: WORKSPACE,
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
    })
    expect(committed).toBe(true)
  })

  it('still rethrows anything else, so a real fault rolls back and retries', async () => {
    reset()
    throwOn.set(UPSERT_SUBSCRIPTION, Object.assign(new Error('connection lost'), { code: '08006' }))

    await expect(applyBillingEvent(checkout(), CONFIG)).rejects.toThrow('connection lost')
    // NOT committed: the claim rolls back with it, so Stripe's retry is a clean re-run rather
    // than an event its own idempotency guard has already swallowed.
    expect(committed).toBe(false)
  })
})
