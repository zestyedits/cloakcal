'use client'

import { useId } from 'react'
import type { DisclosureLevel } from '@cloakcal/policy'
import { audienceIdOf, type AudienceOption } from '@/lib/audiences'
import { useAudienceSwitch } from './audience-transition'
import { useAudienceNames } from './use-audience-names'
import { PrivacyChip } from './ui/privacy-chip'
import styles from './calendar-screen.module.css'

/**
 * View As — spec §4 calls this a trust feature, so it renders through the same server
 * redaction a real recipient gets. Switching audience refetches from the server rather
 * than filtering on the client, because client-side filtering would prove nothing.
 *
 * WHAT THIS OWNS: the CHOICE. The select is how you pick an audience, and the baseline
 * line is what the agenda's chips are measured against.
 *
 * It no longer owns the MODE. Announcing "you are previewing" from a card in the sidebar
 * put the announcement 300px from the content it described on desktop, and above the fold
 * only until you scrolled on a phone. `<PreviewBar>` does that job at the top of the
 * content now. The sheet still owns the MAP: who exists and what each of them gets.
 *
 * AND THE HIDDEN-EVENTS COUNT IS GONE, deliberately — Keith's call, 2026-08-18. See
 * preview-bar.tsx for the reasoning and for what it costs the empty state.
 */
export function ViewAsBar({
  audiences,
  current,
  baselineLevel,
}: {
  audiences: readonly AudienceOption[]
  current: string
  baselineLevel?: DisclosureLevel | undefined
}) {
  // The ONE audience door. This used to build the href and push it itself, which is how
  // three surfaces ended up with three copies of one gesture — and a copy that forgot to
  // seal would leave the owner's titles on screen through the whole fetch.
  const { switchTo } = useAudienceSwitch()
  // useId, not a literal: this renders in the sidebar AND in the Cloak sheet, and two
  // controls sharing id="view-as" would break the label association on both.
  const selectId = useId()

  // Contact and group names are Cloaked (ADR 0004), so the server sends ids and ciphertext
  // and the labels are opened here. An `<option>` holds text rather than elements, which is
  // why this needs a hook returning strings instead of the usual `<CloakedText>`.
  const labelFor = useAudienceNames(audiences)


  return (
    // The accent border stays: it marks the control that put you in this mode, which is
    // where you come back to change it. The MODE itself is announced by <PreviewBar>.
    <div className={styles.viewAs} data-previewing={current !== 'owner' || undefined}>
      <label className={styles.viewAsLabel} htmlFor={selectId}>
        Viewing as
      </label>
      <select
        id={selectId}
        className={styles.viewAsSelect}
        value={current}
        onChange={(event) => {
          // The label is resolved HERE because only this client can read it: contact names
          // are ciphertext (ADR 0004) and the transition announces the name, never the id.
          const chosen = audiences.find((option) => audienceIdOf(option) === event.target.value)
          switchTo(event.target.value, chosen === undefined ? 'someone else' : labelFor(chosen))
        }}
      >
        {audiences.map((audience) => (
          <option key={audience.id} value={audienceIdOf(audience)}>
            {labelFor(audience)}
          </option>
        ))}
      </select>

      {/* THE BASELINE, STATED ONCE, so the absence of a chip on a row has a meaning
          rather than being a gap. Agenda rows and week blocks show a privacy chip only
          where the event DIFFERS from this; every other row shows its calendar instead.
          Without this line that rule would be legible only to whoever wrote it.

          It is the chip component itself, not a re-worded copy: same icon, same words,
          same composited ink pair. A sentence that said "limited" in its own voice would
          be a second vocabulary for one fact, and the two would drift the first time a
          level was renamed.

          Owner only. While previewing, the question on screen is what THIS audience sees,
          and the answer is the calendar underneath rather than a workspace default. */}
      {current === 'owner' && baselineLevel !== undefined && (
        <p className={styles.viewAsBaseline}>
          <span>By default, others see</span>
          <PrivacyChip level={baselineLevel} />
        </p>
      )}

    </div>
  )
}
