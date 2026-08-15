'use client'

import { useId } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { audienceHref, audienceIdOf, type AudienceOption } from '@/lib/audiences'
import { useAudienceNames } from './use-audience-names'
import styles from './calendar-screen.module.css'

/**
 * View As — spec §4 calls this a trust feature, so it renders through the same server
 * redaction a real recipient gets. Switching audience refetches from the server rather
 * than filtering on the client, because client-side filtering would prove nothing.
 *
 * WHAT THIS OWNS, now that the Cloak sheet no longer contains a copy of it: the MODE. It
 * is the one surface that can say "you are currently looking at someone else's view" when
 * nothing is open — the accent border and the hidden-events count — and a dialog by
 * definition cannot, because it is dismissed. The sheet owns the MAP instead: who exists
 * and what each of them gets. The sheet used to render this very component, so switching
 * audience on a phone meant two identical selects in the DOM bound to the same state.
 */
export function ViewAsBar({
  audiences,
  current,
  withheldCount,
}: {
  audiences: readonly AudienceOption[]
  current: string
  withheldCount: number
}) {
  const router = useRouter()
  const params = useSearchParams()
  // useId, not a literal: this renders in the sidebar AND in the Cloak sheet, and two
  // controls sharing id="view-as" would break the label association on both.
  const selectId = useId()

  // Contact and group names are Cloaked (ADR 0004), so the server sends ids and ciphertext
  // and the labels are opened here. An `<option>` holds text rather than elements, which is
  // why this needs a hook returning strings instead of the usual `<CloakedText>`.
  const labelFor = useAudienceNames(audiences)

  const select = (id: string) => {
    router.push(audienceHref(params.toString(), id))
  }

  return (
    // Previewing as someone else is a MODE, and the card's accent border says so — the
    // note alone scrolls away with the card on mobile, a border does not go unnoticed.
    <div className={styles.viewAs} data-previewing={current !== 'owner' || undefined}>
      <label className={styles.viewAsLabel} htmlFor={selectId}>
        Viewing as
      </label>
      <select
        id={selectId}
        className={styles.viewAsSelect}
        value={current}
        onChange={(event) => select(event.target.value)}
      >
        {audiences.map((audience) => (
          <option key={audience.id} value={audienceIdOf(audience)}>
            {labelFor(audience)}
          </option>
        ))}
      </select>

      {current !== 'owner' && (
        <p className={styles.viewAsNote}>
          {withheldCount === 0
            ? 'They can see every event below.'
            : `${withheldCount} ${withheldCount === 1 ? 'event is' : 'events are'} hidden from them entirely.`}
        </p>
      )}
    </div>
  )
}
