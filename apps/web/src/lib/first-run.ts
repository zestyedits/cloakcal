'use client'

/**
 * The first-contact prompt's two remembered facts.
 *
 * `localStorage`, per device, and that is a decision rather than a shortcut. The alternative
 * is a preference column, which means a migration, an RPC, a read on every calendar render
 * and a write path, for a dismissal. The cost of getting it per-device is that somebody who
 * dismissed it on a laptop could see it once on a phone — and even that cannot happen in
 * practice, because ARMED is per-device too, so the phone would have to be a device they had
 * also created their first event on.
 *
 * ARMED is the interesting half. The prompt does not ask "does this calendar have events" —
 * it asks "did you just make your first one here", which is what stops it greeting somebody
 * who has been using the product for a month with an invitation aimed at a beginner. It is
 * set once, by a successful create or a successful seed, and never cleared.
 *
 * THERE IS NO RE-ARM PATH, ON PURPOSE. No "show me again", no counter, no reappearing after
 * n days. The prompt retires two ways — a contact exists, or it was dismissed — and returns
 * from neither. An onboarding hint that can come back is an onboarding obligation.
 */

const ARMED = 'cloakcal.first-run.armed'
const DISMISSED = 'cloakcal.first-run.audience-dismissed'

/**
 * Every read is guarded and every failure is silent, because the honest fallback is the same
 * in both directions: Safari in private mode and a browser with storage disabled both throw
 * on access, and the right answer to "we cannot tell" is to show nothing rather than to show
 * an invitation that can never be dismissed.
 */
const read = (key: string): boolean => {
  try {
    return globalThis.localStorage?.getItem(key) === '1'
  } catch {
    return false
  }
}

const write = (key: string): void => {
  try {
    globalThis.localStorage?.setItem(key, '1')
  } catch {
    // Nothing to do and nothing to say: the prompt simply will not appear, or will appear
    // once more. Neither is worth an error in front of somebody who just saved an event.
  }
}

/** Called by a successful first create or seed. Idempotent. */
export const armFirstRun = (): void => write(ARMED)

export const isFirstRunArmed = (): boolean => read(ARMED)

export const dismissAudiencePrompt = (): void => write(DISMISSED)

export const isAudiencePromptDismissed = (): boolean => read(DISMISSED)

/**
 * THE FIVE CONDITIONS, AS A SIGNATURE RATHER THAN AS A COMMENT.
 *
 * They were an inline `if` in the component and a numbered list above it, which meant nothing
 * could check that the list and the code still agreed, and nothing in this repo could exercise
 * either: the fixture ships demo audiences, so condition 4 is false on every Playwright
 * project and that component has never been rendered by any test or seen by axe.
 *
 * Splitting the decision out is the same move `lib/settings-summary.ts` made for the settings
 * hub, and for the same reason -- the pure half becomes testable even though the wire it runs
 * on cannot be reached from here. `first-run.client.test.ts` covers every branch.
 *
 * WHAT THIS STILL DOES NOT COVER, and the release gate that remains: whether a real account
 * with a real workspace actually arrives at these five values. That needs the throwaway-account
 * recipe. A predicate proving "given no contacts, offer the prompt" says nothing about whether
 * the contact count reaching it was correct.
 *
 * Every clause is required, and each one is load-bearing:
 *
 *   armed         a successful FIRST save on this device, not "the calendar has events" --
 *                 otherwise it greets somebody who has used the product for a month.
 *   dismissed     retires it forever. There is no re-arm path anywhere in this module.
 *   isOwner       previewing as someone else is looking at a calendar that is not yours to
 *                 configure, so suggesting a contact there is incoherent.
 *   hasEvents     keeps it off an empty week the user has merely navigated to. `armed` is
 *                 durable; this is about the page in front of them.
 *   hasAudiences  the moment one contact or group exists, the product explains itself and the
 *                 invitation has done its job. This retires it forever too.
 */
export const shouldOfferAudiencePrompt = (conditions: {
  armed: boolean
  dismissed: boolean
  isOwner: boolean
  hasEvents: boolean
  hasAudiences: boolean
}): boolean =>
  conditions.armed &&
  !conditions.dismissed &&
  conditions.isOwner &&
  conditions.hasEvents &&
  !conditions.hasAudiences
