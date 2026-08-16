import type { BillingState } from '@/server/billing/view'

/**
 * EVERY WORD THE BILLING BAND SAYS, IN ONE PLACE, KEYED BY STATE.
 *
 * `describeBilling` switches exhaustively with a `never` branch, exactly as `purchaseLabel`
 * does, so an eighth `BillingState` is a COMPILE ERROR here rather than a state that renders
 * with no words. Copy scattered across seven JSX branches is copy where one branch quietly
 * ends up saying nothing, and the branch that says nothing is always the rare one — which on
 * this screen means `past_due`, i.e. the person whose payment is failing.
 *
 * IT LIVES IN lib/ AND IMPORTS ONLY A TYPE. `lib/settings-sections.ts` states the rule in
 * full: a server component importing a plain value out of a `'use client'` module gets a
 * client-reference proxy, and inside a Suspense fallback that renders as a DOUBLED PAGE
 * rather than an error. Both a server component and a client island read this, so it belongs
 * here, and the `import type` keeps `server/billing/view.ts` — which pulls in the Stripe SDK —
 * out of anything this touches.
 *
 * THE VOICE. Plain, short, and every state answers the same three questions in the same
 * order, because they are the three a person actually has:
 *
 *   1. What is true right now?
 *   2. Has money moved, or will it?
 *   3. What happens to my calendar?
 *
 * The third one matters more here than anywhere else in the product. This is a privacy
 * calendar: the fear at the moment somebody cancels is not "will I lose a feature", it is
 * "will I lose my events". Every state that could be read as a loss says outright that
 * nothing is deleted.
 *
 * NO EM DASHES anywhere below. `e2e/plan.spec.ts` asserts it against the rendered DOM.
 */

export interface BillingCopy {
  /** The sentence under "Your plan". */
  readonly summary: string
  /** The paragraph under the actions, or null when the summary says enough. */
  readonly detail: string | null
}

export function describeBilling(state: BillingState, renewsOn: string | null): BillingCopy {
  // Every date-bearing sentence has a dateless twin, because `renewsOn` is genuinely null
  // whenever Stripe could not be reached AND our own column never got written. "You are on
  // Pro until null" is the kind of thing that ships.
  const on = renewsOn === null ? null : renewsOn

  switch (state) {
    case 'none':
      return {
        summary: 'You are on Free. Everything CloakCal does today is included.',
        detail:
          'There is no card on file and nothing has been charged. Pro is below if you want the things it adds.',
      }

    case 'lapsed':
      return {
        summary:
          on === null
            ? 'Your Pro subscription has ended. You are on Free now.'
            : `Your Pro subscription ended on ${on}. You are on Free now.`,
        detail:
          'Nothing was removed from your calendar. Your events, contacts and visibility rules are all exactly where they were. You can start Pro again below.',
      }

    case 'granted':
      return {
        summary: 'You are on Pro.',
        detail:
          'This account was given Pro directly rather than through a payment, so there is no card on file, no renewal date and nothing to cancel. Get in touch if that needs to change.',
      }

    case 'active':
      return {
        summary:
          on === null
            ? 'You are on Pro, and it renews automatically.'
            : `You are on Pro. It renews on ${on}.`,
        detail: null,
      }

    case 'cancelling':
      return {
        summary:
          on === null
            ? 'You are on Pro until the end of the period you have paid for, and it will not renew.'
            : `You are on Pro until ${on}, and it will not renew.`,
        detail:
          on === null
            ? 'After that the account goes back to Free. Your calendar, your events, your contacts and your rules all stay exactly as they are. Nothing is deleted and nothing is hidden.'
            : `On ${on} the account goes back to Free. Your calendar, your events, your contacts and your rules all stay exactly as they are. Nothing is deleted and nothing is hidden.`,
      }

    case 'past_due':
      return {
        summary: 'Your last payment did not go through.',
        detail:
          'Stripe will try again over the next few days. Updating your card makes it retry straight away. Nothing is locked in the meantime, and if the retries all fail the account simply goes back to Free with your calendar untouched.',
      }

    case 'unreadable':
      return {
        summary: 'We could not read your billing details just now.',
        detail:
          'Nothing has changed and nothing has been charged. Reload the page, and get in touch if it keeps happening.',
      }

    default: {
      const unhandled: never = state
      throw new Error(`unhandled billing state: ${String(unhandled)}`)
    }
  }
}

/**
 * Whether this state may draw a control that starts a payment.
 *
 * `unreadable` IS THE ONE WORTH READING TWICE. A degraded read means we do not know what the
 * account is on, and the plan column already degraded to Free to get here. Offering "Continue
 * to Stripe" to somebody who might already be paying, who presses it, produces a second
 * subscription and two charges a month. Free's generosity is correct for a badge and wrong
 * for a button.
 */
export function canPurchase(state: BillingState): boolean {
  return state === 'none' || state === 'lapsed'
}

/**
 * Whether this state may draw cancel, resume, or a cadence switch.
 *
 * Note this is about the STATE. The band additionally requires a non-null subscription id
 * before rendering any of them, because a Cancel button that posts a null id is a 500 on an
 * account that never paid. Two gates for one fact, which is the shape 0024 uses for the same
 * reason: the second one catches the case the first was not written for.
 */
export function canManage(state: BillingState): boolean {
  return state === 'active' || state === 'cancelling' || state === 'past_due'
}
