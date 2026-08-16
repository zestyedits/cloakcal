import { describe, expect, it } from 'vitest'
import { billingState, type LiveSubscriptionFacts } from '../src/server/billing/view'
import { type SubscriptionRow } from '../src/server/plan'

/**
 * Which of the seven states an account is in.
 *
 * This is the whole decision the plan screen renders from, and every case below is one the
 * screen draws differently. It is a pure function precisely so all seven can be reached
 * without a database, a Stripe account or a card — the alternative is a state nobody has ever
 * seen shipping alongside copy nobody has ever read.
 */

const FREE: SubscriptionRow = {
  plan: 'free',
  providerCustomerId: null,
  providerSubscriptionId: null,
  providerStatus: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  degraded: false,
}

const PRO: SubscriptionRow = {
  ...FREE,
  plan: 'pro',
  providerCustomerId: 'cus_1',
  providerSubscriptionId: 'sub_1',
  providerStatus: 'active',
  currentPeriodEnd: '2026-09-16T00:00:00+00:00',
}

const live = (over: Partial<LiveSubscriptionFacts> = {}): LiveSubscriptionFacts => ({
  cancelAtPeriodEnd: false,
  status: 'active',
  ...over,
})

describe('billingState', () => {
  it('is none for an account that has never bought anything', () => {
    expect(billingState(FREE)).toBe('none')
  })

  it('is lapsed for a free account that once had a customer at the processor', () => {
    expect(billingState({ ...FREE, providerCustomerId: 'cus_1' })).toBe('lapsed')
  })

  it('is active for a healthy paid subscription', () => {
    expect(billingState(PRO)).toBe('active')
    expect(billingState({ ...PRO, providerStatus: 'trialing' })).toBe('active')
  })

  it('is cancelling when the subscription will not renew', () => {
    expect(billingState({ ...PRO, cancelAtPeriodEnd: true })).toBe('cancelling')
  })

  it('is past_due for any status that is not healthy', () => {
    for (const status of ['past_due', 'unpaid', 'incomplete', 'incomplete_expired', 'paused']) {
      expect(billingState({ ...PRO, providerStatus: status }), status).toBe('past_due')
    }
  })

  /**
   * A partial row written by a webhook that got half way is a payment we cannot vouch for.
   * Reading it as active would tell somebody their subscription is fine on the strength of a
   * row that says nothing about whether it is.
   */
  it('is past_due when a subscription exists but carries no status at all', () => {
    expect(billingState({ ...PRO, providerStatus: null })).toBe('past_due')
  })

  /**
   * Pro with no subscription id is an account granted Pro by hand. The distinction exists so
   * the screen can key its management controls off the subscription id rather than off the
   * plan: a Cancel button that posts a null id 500s on an account that never paid.
   */
  it('is granted for Pro with no subscription, whatever else the row says', () => {
    const granted = { ...PRO, providerSubscriptionId: null }
    expect(billingState(granted)).toBe('granted')
    expect(billingState({ ...granted, cancelAtPeriodEnd: true })).toBe('granted')
    expect(billingState({ ...granted, providerStatus: 'past_due' })).toBe('granted')
  })

  it('is unreadable when the read was degraded, whatever the row appears to say', () => {
    expect(billingState({ ...PRO, degraded: true })).toBe('unreadable')
    expect(billingState({ ...FREE, degraded: true })).toBe('unreadable')
  })
})

describe('billingState with live facts from the processor', () => {
  /**
   * THIS IS THE CASE THE LIVE FACTS EXIST FOR. Only `billing_writer` writes our row and it
   * only runs in the webhook, so between an in-app cancel and the webhook landing our column
   * still says false. Without this, a user who just pressed Cancel would be told the
   * subscription renews on 3 March.
   */
  it('reports cancelling from the processor before our own row has caught up', () => {
    expect(PRO.cancelAtPeriodEnd).toBe(false)
    expect(billingState(PRO, live({ cancelAtPeriodEnd: true }))).toBe('cancelling')
  })

  it('reports active again after a resume, before our row has caught up', () => {
    const cancelling = { ...PRO, cancelAtPeriodEnd: true }
    expect(billingState(cancelling, live({ cancelAtPeriodEnd: false }))).toBe('active')
  })

  it('takes the status from the processor too', () => {
    expect(billingState(PRO, live({ status: 'past_due' }))).toBe('past_due')
    expect(billingState({ ...PRO, providerStatus: 'past_due' }, live())).toBe('active')
  })

  /**
   * A payment problem outranks a pending cancellation, because it is the one with an action
   * attached. "You keep Pro until 3 March" is a promise we cannot make while the renewal that
   * would pay for it is bouncing.
   */
  it('prefers the payment problem when an account is both cancelling and failing', () => {
    expect(billingState(PRO, live({ cancelAtPeriodEnd: true, status: 'past_due' }))).toBe(
      'past_due',
    )
  })

  /**
   * THE ENTITLEMENT NEVER COMES FROM THE PROCESSOR. Live facts choose between three states
   * that are all already Pro; they can never turn a free account into a paid one. If this ever
   * fails, the paywall has acquired an outbound HTTP call and fails open when Stripe is slow.
   */
  it('cannot promote a free account, however healthy the processor says it is', () => {
    expect(billingState(FREE, live({ status: 'active' }))).toBe('none')
    expect(billingState({ ...FREE, providerCustomerId: 'cus_1' }, live())).toBe('lapsed')
  })

  it('cannot rescue a degraded read', () => {
    expect(billingState({ ...PRO, degraded: true }, live())).toBe('unreadable')
  })
})
