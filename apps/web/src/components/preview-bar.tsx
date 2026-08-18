'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { audienceHref, audienceIdOf, type AudienceOption } from '@/lib/audiences'
import { useAudienceNames } from './use-audience-names'
import { Button } from './ui/button'
import styles from './preview-bar.module.css'

/**
 * "You are looking at someone else's view", said where the user is actually looking.
 *
 * View As is the product's whole argument and it was announced by an accent border on one
 * card in the sidebar, which on a phone is above the fold only until you scroll and on a
 * desktop is 300px away from the content it describes. Someone who scrolls into the middle
 * of a week has no way to tell a restricted view from their own, and a calendar that is
 * quietly lying to you about your own week is worse than one that never offered the
 * feature. The bar sits at the top of the content, sticks there, and cannot be missed.
 *
 * IT CARRIES THE AUDIENCE AND THE WAY OUT, AND NOTHING ELSE. There is deliberately no
 * "N events hidden" count here: it is Keith's call, taken 2026-08-18, and it is the
 * conservative reading of "hidden means absent" — the count is owner-only metadata about a
 * viewer, and the product does not put a number on what it is hiding. The cost is stated
 * rather than hidden: the empty state can no longer distinguish "this audience sees
 * nothing" from "this week is empty" by a number, so it distinguishes them by wording
 * instead (see calendar-screen.tsx).
 *
 * The accent is a SHAPE here, never ink: the edge and the wash carry the state, and every
 * word in the bar is ordinary text ink against a pair already in CONTRAST_PAIRS.
 */
export function PreviewBar({
  audiences,
  current,
}: {
  audiences: readonly AudienceOption[]
  current: string
}) {
  const router = useRouter()
  const params = useSearchParams()

  // Contact names are Cloaked (ADR 0004), so the server sent an id and this opens it.
  // Before unlock it reads `Contact 4f2a…`, which is what the server itself can see.
  const labelFor = useAudienceNames(audiences)
  // Matched through audienceIdOf, the same function the select's option values come from:
  // 'public' and 'owner' are bare kinds while a contact is 'contact:<id>', and comparing
  // raw ids would quietly fail on exactly the two audiences that are not rows in a table.
  const audience = audiences.find((option) => audienceIdOf(option) === current)

  return (
    <div className={styles.bar}>
      <p className={styles.text}>
        {/* The verb is present tense and about the reader, not about a setting. "Preview
            mode" would name a feature; "you are seeing" names the situation. */}
        Previewing as <strong>{audience === undefined ? 'someone else' : labelFor(audience)}</strong>
      </p>
      <Button
        variant="outline"
        size="sm"
        onClick={() => router.push(audienceHref(params.toString(), 'owner'))}
      >
        Back to my view
      </Button>
    </div>
  )
}
