import { describe, expect, it } from 'vitest'
import { readSubscriptionRow } from '../src/server/plan'

/**
 * The mapper between a PostgREST row and the shape the plan screen reasons about.
 *
 * Pure, and tested here rather than through `loadSubscription`, because every interesting
 * case is about a row that is malformed, partial, or from a database one migration behind —
 * none of which a live query will produce on demand. `loadSubscription` owns the query and
 * the retry; this owns what the answer means.
 */

describe('readSubscriptionRow', () => {
  it('reads a complete Pro row', () => {
    expect(
      readSubscriptionRow(
        {
          plan: 'pro',
          provider_customer_id: 'cus_1',
          provider_subscription_id: 'sub_1',
          provider_status: 'active',
          current_period_end: '2026-09-16T00:00:00+00:00',
          cancel_at_period_end: false,
        },
        false,
      ),
    ).toEqual({
      plan: 'pro',
      providerCustomerId: 'cus_1',
      providerSubscriptionId: 'sub_1',
      providerStatus: 'active',
      currentPeriodEnd: '2026-09-16T00:00:00+00:00',
      cancelAtPeriodEnd: false,
      degraded: false,
    })
  })

  /**
   * A CLAMP BEATS TRUSTING A CAST, and it fails toward Free. A CHECK constraint stands behind
   * this column, which is a reason to expect 'free' or 'pro' and not a reason to trust the
   * string on this side of the wire. `loadWorkspacePrefs` clamps `default_view` for the same
   * reason; the difference is that a wrong view is cosmetic and a wrong plan is an entitlement.
   */
  it('clamps an unknown plan to free rather than believing it', () => {
    for (const plan of ['enterprise', 'PRO', '', null, undefined, 1]) {
      expect(readSubscriptionRow({ plan }, false).plan, `${String(plan)} is not a plan`).toBe(
        'free',
      )
    }
  })

  /**
   * A Pro row with no subscription id is an account granted Pro by hand. It has no card, no
   * renewal and nothing to cancel, and the plan screen keys every management control off the
   * subscription id rather than off the plan precisely so a Cancel button cannot post a null
   * and 500 on an account that never paid.
   */
  it('keeps a granted Pro row distinguishable, with no provider ids', () => {
    const row = readSubscriptionRow({ plan: 'pro' }, false)
    expect(row.plan).toBe('pro')
    expect(row.providerSubscriptionId).toBeNull()
    expect(row.providerCustomerId).toBeNull()
    expect(row.degraded).toBe(false)
  })

  /**
   * Stripe's status vocabulary is Stripe's. Mapping `unpaid` or `incomplete_expired` onto
   * something of our own here would mean two places decide what a status means and one of
   * them is guessing; the screen owns the copy and gets the raw word.
   */
  it('carries an unrecognised status through unchanged', () => {
    for (const status of ['incomplete_expired', 'unpaid', 'paused', 'something_new']) {
      expect(readSubscriptionRow({ plan: 'pro', provider_status: status }, false).providerStatus).toBe(
        status,
      )
    }
  })

  /**
   * The column is `not null default false`, so `undefined` means the SELECT never asked —
   * i.e. the 42703 retry fired against a database that has run 0024 and not 0028. Coerce, and
   * never toward true: a spurious `cancelAtPeriodEnd` tells a paying customer their
   * subscription is ending.
   */
  it('never invents a pending cancellation', () => {
    for (const value of [undefined, null, '', 'false', 'true', 0, 1]) {
      expect(
        readSubscriptionRow({ plan: 'pro', cancel_at_period_end: value }, false).cancelAtPeriodEnd,
        `${String(value)} must not read as cancelling`,
      ).toBe(false)
    }
    expect(readSubscriptionRow({ cancel_at_period_end: true }, false).cancelAtPeriodEnd).toBe(true)
  })

  it('treats an empty string as absent, not as a value', () => {
    const row = readSubscriptionRow(
      { plan: 'pro', provider_customer_id: '', provider_status: '', current_period_end: '' },
      false,
    )
    expect(row.providerCustomerId).toBeNull()
    expect(row.providerStatus).toBeNull()
    expect(row.currentPeriodEnd).toBeNull()
  })

  /**
   * `degraded` is about the QUERY, not the row, which is why it is a parameter. The plan
   * screen draws no purchase and no management control while it is true — a paying customer
   * shown an upgrade button, who presses it, is charged twice.
   */
  it('reports degraded exactly as it was told, without inferring it from the row', () => {
    expect(readSubscriptionRow({ plan: 'pro' }, true).degraded).toBe(true)
    expect(readSubscriptionRow({}, false).degraded).toBe(false)
  })

  it('leaves the timestamp as text, never as a Date', () => {
    const row = readSubscriptionRow({ current_period_end: '2026-09-16T00:00:00+00:00' }, false)
    expect(typeof row.currentPeriodEnd).toBe('string')
  })
})
