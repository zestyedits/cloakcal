'use client'

import { useEffect, useId, useMemo, useRef } from 'react'
import {
  decisionToLevel,
  evaluate,
  explainDecision,
  type EvaluateInput,
  type ViewerIdentity,
  type VisibilityRule,
} from '@cloakcal/policy'
import { audienceIdOf, type AudienceOption } from '@/lib/audiences'
import { useAudienceSwitch } from './audience-transition'
import { useAudienceNames } from './use-audience-names'
import { PrivacyChip } from './ui/privacy-chip'
import { Button, ButtonLink } from './ui/button'
import sheetStyles from './event-sheet.module.css'
import styles from './cloak-sheet.module.css'

/**
 * The Cloak destination — the centre slot of the bottom nav, per the board: privacy is a
 * place you go, not a setting buried in an event.
 *
 * What lives here: the MAP. One row per audience saying what they see of a rule-less
 * event — level chip plus the ENGINE'S OWN sentence, `explainDecision(evaluate(...))`,
 * never a restatement, because rule 3 allows exactly one interpreter of a visibility
 * decision. Each row is also the door into previewing as that person.
 *
 * WHAT IS DELIBERATELY NOT HERE ANY MORE: the View As picker. This sheet used to render
 * the sidebar's `<ViewAsBar>` component itself, which meant that with the sheet open there
 * were two live "Viewing as" selects in the DOM, bound to the same state, writing the same
 * URL — and two near-identical copies of the audience-name fallback that could drift apart.
 * The comment justifying it said View As was "finally thumb-reachable on mobile", which
 * had stopped being true: the sidebar deliberately keeps View As on phones for exactly
 * that reason, so two comments were justifying the same control twice.
 *
 * The split now: the sidebar bar owns the MODE (it is the only thing that can say you are
 * previewing when nothing is open), this sheet owns the MAP and the way in.
 *
 * Client state and a native <dialog>, like the event sheets: mounting is opening, no exit
 * choreography (the close-in-cleanup trap), Escape and backdrop handled by the platform.
 */
export function CloakSheet({
  audiences,
  currentAudience,
  workspaceRules,
  groupsByContact,
  onClose,
}: {
  audiences: readonly AudienceOption[]
  currentAudience: string
  workspaceRules: readonly VisibilityRule[]
  groupsByContact: Readonly<Record<string, readonly string[]>>
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  // Ids for the per-row description. useId, not a literal: this sheet is one instance today
  // but an id collision is the failure mode that has no symptom until a screen reader hits it.
  const rowIdBase = useId()
  const { switchTo } = useAudienceSwitch()

  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (dialog !== null && !dialog.open) dialog.showModal()
    /*
     * FOCUS THE SHEET, NOT THE FIRST THING IN IT.
     *
     * `showModal()` focuses the first tabbable descendant, and that is Close -- so opening
     * the product's signature privacy surface put a focus ring on the DISMISS control and
     * made it the visually dominant element on the sheet. It looked like a bordered button
     * twice the weight of anything else; it is `variant="ghost"` and has no border at all.
     * A screenshot is the only thing that showed it.
     *
     * The W3C modal-dialog pattern says focus the dialog itself when no single control is
     * the obvious first action, which is the case here: the sheet is a map to read, not a
     * form to fill. `tabIndex={-1}` makes the body programmatically focusable without
     * putting it in the tab order.
     */
    bodyRef.current?.focus()
  }, [])

  const rows = audiences.filter((a) => a.kind !== 'owner')
  // Declared above `preview`, which calls it: the transition announces the decrypted name
  // rather than the id, and contact names are ciphertext the server never sees.
  const nameOf = useAudienceNames(audiences)

  const now = useMemo(() => new Date().toISOString(), [])

  /**
   * Preview as this audience: close first, then navigate.
   *
   * Closing first because the sheet is a modal over the very page that is about to change
   * underneath it — leaving it open would hide the answer the user just asked for. The
   * sidebar's bar is where the resulting mode is then visible, which is the whole reason
   * it stayed.
   */
  const preview = (option: AudienceOption) => {
    ref.current?.close()
    // Through the shared door, so this route seals exactly like the sidebar's picker. The
    // name is resolved here because only this client can read it.
    switchTo(audienceIdOf(option), nameOf(option))
  }

  const decisionFor = (option: AudienceOption) => {
    const viewer: ViewerIdentity =
      option.kind === 'public'
        ? { kind: 'public' }
        : option.kind === 'group'
          ? { kind: 'individual', contactId: `group:${option.id}`, groupIds: [option.id] }
          : {
              kind: 'individual',
              contactId: option.id,
              groupIds: groupsByContact[option.id] ?? [],
            }
    const input: EvaluateInput = {
      event: {
        eventId: '00000000-0000-4000-8000-000000000000',
        workspaceId: 'preview',
        lifecycle: 'active',
        rules: [],
      },
      viewer,
      workspace: { workspaceId: 'preview', timeVis: 'hidden', fields: {}, rules: [...workspaceRules] },
      now,
      policyVersion: 'v1',
    }
    return evaluate(input)
  }

  return (
    <dialog ref={ref} className={sheetStyles.sheet} aria-labelledby={titleId} onClose={onClose}>
      <div className={sheetStyles.body} ref={bodyRef} tabIndex={-1}>
        <div className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            Cloak
          </h2>
          {/* A 44px icon control, not a 44px word. The hit area is identical; what changes
              is that it stops competing with the heading for the eye. */}
          <button
            type="button"
            className={styles.close}
            aria-label="Close"
            onClick={() => ref.current?.close()}
          >
            <span aria-hidden="true">&times;</span>
          </button>
        </div>

        {/*
          ONE SENTENCE, AND IT NO LONGER CLAIMS A LINK EXISTS.

          This read "Every person and link that can reach your calendar". Nothing in CloakCal
          can be sent to anyone -- `access_envelopes` is unused and `deriveFieldKey` returns a
          non-extractable key -- so no link reaches anybody. lib/plans.ts already bans that
          phrasing in a feature list for exactly this reason; this sheet was the one surface
          still making the claim, and it made it as a statement of FACT about reach rather
          than as the name of a rule being set.
        */}
        <p className={styles.lede}>Choose what each person can see.</p>

        {rows.map((option) => {
          const decision = decisionFor(option)
          const id = audienceIdOf(option)
          const name = nameOf(option)
          const viewing = id === currentAudience
          /*
            THE ROW IS THE CONTROL, not a row with a control under it.
            Every row used to carry a full-width "View as {name}" button repeating a name
            printed two lines above it, which made each audience 76px of sheet for one
            action. The row is now the button and the chevron says so.

            The CURRENT audience stays a plain <div>. It is not a disabled button -- that
            would read as "this person cannot be previewed" -- and it is not an enabled one,
            because a control that navigates to where you already are teaches that controls
            do nothing. Same rule the header's Today control follows.
          */
          const sentenceId = `${rowIdBase}-${id}-consequence`
          const inner = (
            <>
              <span className={styles.audienceName}>{name}</span>
              <PrivacyChip level={decisionToLevel(decision)} />
              {/* On the NAME row, not after the sentence. `.audience` is a wrapping flex and
                  `.consequence` is width: 100%, so a chevron placed after it wraps onto a
                  line of its own and adds 24px of empty row per audience. */}
              {!viewing && (
                <span className={styles.audienceChevron} aria-hidden="true">
                  &rsaquo;
                </span>
              )}
              {/* The engine's sentence, verbatim. Rule 3 allows one interpreter of a
                  visibility decision, and quoting it here is that rule holding. */}
              <p id={sentenceId} className={styles.consequence}>
                {explainDecision(decision)}
              </p>
              {/*
                THE PUBLIC AUDIENCE IS A RULE, NOT A REACH, AND THE ROW HAS TO SAY SO.
                "Anyone with the link" is the same vocabulary the settings control uses, and
                it is honest there because it names something you are SETTING. On a sheet
                titled "who can see what" it reads as a link that exists. None does.
              */}
              {option.kind === 'public' && (
                <p className={styles.futureRule}>
                  No link exists yet. This is the rule it will follow.
                </p>
              )}
            </>
          )

          return viewing ? (
            <div key={option.id} className={styles.audience} data-viewing>
              {inner}
              <p className={styles.viewingNow}>You are viewing as {name} now</p>
            </div>
          ) : (
            <button
              key={option.id}
              type="button"
              className={styles.audience}
              /*
               * THE NAME IS THE ACTION; THE SENTENCE IS THE DESCRIPTION.
               *
               * Without this the button's accessible name is everything inside it -- name,
               * chip label and the whole consequence sentence -- read out as one run-on
               * control name. Same split `settings-doors.tsx` uses, and the same reason.
               *
               * WCAG 2.5.3 is satisfied because the name CONTAINS the row's visible label,
               * which is the person's name; the chip and the sentence are supplementary
               * description rather than the thing identifying the control. It also keeps
               * "View as {name}" as the accessible contract the e2e suite already asserts,
               * even though the full-width button that used to print those words is gone.
               */
              aria-label={`View as ${name}`}
              aria-describedby={sentenceId}
              onClick={() => preview(option)}
            >
              {inner}
            </button>
          )
        })}

        {/* Only when previewing: the way back. Owner is not in `rows`, so without this the
            sheet could take you into a preview and not out of it. */}
        {currentAudience !== 'owner' && (
          <Button
            variant="outline"
            size="sm"
            className={styles.exitPreview}
            onClick={() => {
              ref.current?.close()
              switchTo('owner', 'your own')
            }}
          >
            Back to my own view
          </Button>
        )}

        <ButtonLink
          variant="outline"
          size="sm"
          className={styles.settingsLink}
          href="/settings/privacy"
        >
          Adjust in Settings
        </ButtonLink>
      </div>
    </dialog>
  )
}
