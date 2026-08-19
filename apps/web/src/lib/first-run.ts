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
