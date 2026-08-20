'use client'

import { useEffect, useState } from 'react'
import {
  dismissAudiencePrompt,
  isAudiencePromptDismissed,
  isFirstRunArmed,
  shouldOfferAudiencePrompt,
} from '@/lib/first-run'
import { Button } from './ui/button'
import styles from './first-audience-prompt.module.css'

/**
 * The one invitation, and the gap it closes.
 *
 * A new account has no contacts. `PrivacyChip` renders only where an event DIFFERS from the
 * workspace baseline — and with no audiences, nothing can differ — so no chip ever appears on
 * any row. View As is a select with one option. The sidebar says "By default, others see
 * Hidden" about nobody. Every surface carrying the product's actual argument is inert, and
 * nothing anywhere suggests that the missing ingredient is a person.
 *
 * So: one line, one button, after you have something to show someone.
 *
 * ---------------------------------------------------------------------------
 * FIVE CONDITIONS, ALL REQUIRED
 * ---------------------------------------------------------------------------
 *
 *   1. You are looking at your OWN calendar. Suggesting a contact while previewing as
 *      somebody else would be asking you to configure a calendar that is not yours.
 *   2. ARMED by a successful first save. Not "the calendar has events" — that would greet a
 *      returning user out of nowhere. See lib/first-run.ts.
 *   3. The visible page holds at least one event, so it never floats over an empty week the
 *      user has simply navigated to.
 *   4. There are no contacts and no groups.
 *   5. It has not been dismissed.
 *
 * It retires two ways and returns from neither: creating any contact falsifies 4 forever,
 * dismissing falsifies 5 forever. No re-arm, no counter, no reappearance.
 *
 * ---------------------------------------------------------------------------
 * WHY IT OPENS THE EVENT VISIBILITY SHEET
 * ---------------------------------------------------------------------------
 *
 * The obvious destination is the People register, and it is the wrong one: it would teach
 * "add a contact", which is a chore, and leave the user to discover on their own that the
 * point was ever privacy. The visibility sheet already owns a quick-add, so adding the person
 * and choosing what they see happen in one place, against a real event the user just made.
 * The invitation is therefore a concrete action rather than an explanation — "Choose what
 * someone sees", not "CloakCal lets you control visibility".
 *
 * ---------------------------------------------------------------------------
 * NOTHING IN THIS REPO CAN CURRENTLY RENDER IT
 * ---------------------------------------------------------------------------
 *
 * The fixture ships demo audiences, so condition 4 is false on every Playwright project and
 * axe has never seen this component. That is the same shape as the settings hub's four lines
 * and the contact-name ingest bug, and it means the spec covering this has to force the state
 * explicitly rather than trusting a fixture that structurally cannot reach it.
 */
export function FirstAudiencePrompt({
  isOwner,
  hasEvents,
  hasAudiences,
  onOpen,
}: {
  isOwner: boolean
  hasEvents: boolean
  /** Any contact or group. One is enough for the product to explain itself. */
  hasAudiences: boolean
  onOpen: () => void
}) {
  /**
   * Both remembered facts live in localStorage, which does not exist during the server
   * render, so this starts closed and opens in an effect. That also means it can never cause
   * a hydration mismatch: the server and the first client frame agree on "not shown".
   *
   * The initial pair is `armed: false, dismissed: true` -- either alone would keep it hidden,
   * and stating both is the honest starting position rather than a belt-and-braces habit: we
   * have not read storage yet, so the truthful answer to both questions is the one that shows
   * nothing.
   */
  const [storage, setStorage] = useState({ armed: false, dismissed: true })
  useEffect(() => {
    setStorage({ armed: isFirstRunArmed(), dismissed: isAudiencePromptDismissed() })
  }, [])

  /* The decision itself lives in lib/first-run.ts, where every branch of it is tested. The
     five conditions used to be an inline `if` beside the numbered list above, so nothing could
     check that the list and the code still agreed -- and nothing here can render this
     component at all. See that function's header for the gate that remains. */
  if (!shouldOfferAudiencePrompt({ ...storage, isOwner, hasEvents, hasAudiences })) return null

  return (
    /*
     * Ordinary content in reading order, NOT a live region. It is a state, not news — nothing
     * just happened, and announcing it would interrupt somebody who is reading their week.
     */
    <div className={styles.prompt}>
      <p className={styles.text}>
        Nobody can see this calendar yet. Add one person and you can look at your week through
        their eyes.
      </p>
      <Button size="sm" onClick={onOpen}>
        Choose what someone sees
      </Button>
      {/* A real labelled button at the full touch floor, never a bare glyph: an "x" in a
          quiet corner reads as decoration to anything that is not a pointer. */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          dismissAudiencePrompt()
          setStorage((current) => ({ ...current, dismissed: true }))
        }}
      >
        Not now
      </Button>
    </div>
  )
}
