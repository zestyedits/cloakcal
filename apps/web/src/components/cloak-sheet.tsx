'use client'

import { useEffect, useId, useMemo, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  decisionToLevel,
  evaluate,
  explainDecision,
  type EvaluateInput,
  type ViewerIdentity,
  type VisibilityRule,
} from '@cloakcal/policy'
import { audienceHref, audienceIdOf, type AudienceOption } from '@/lib/audiences'
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
  const router = useRouter()
  const params = useSearchParams()

  useEffect(() => {
    const dialog = ref.current
    if (dialog !== null && !dialog.open) dialog.showModal()
  }, [])

  const rows = audiences.filter((a) => a.kind !== 'owner')
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
    router.push(audienceHref(params.toString(), audienceIdOf(option)))
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
      <div className={sheetStyles.body}>
        <div className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            Cloak
          </h2>
          <Button
            variant="ghost"
            size="sm"
            className={styles.close}
            onClick={() => ref.current?.close()}
          >
            Close
          </Button>
        </div>

        <p className={styles.lede}>
          Who sees what. Every person and link that can reach your calendar, and what each
          one gets by default. Open any of them to see your calendar through their eyes.
        </p>

        {rows.map((option) => {
          const decision = decisionFor(option)
          const id = audienceIdOf(option)
          const name = nameOf(option)
          const viewing = id === currentAudience
          return (
            <div key={option.id} className={styles.audience} data-viewing={viewing || undefined}>
              <span className={styles.audienceName}>{name}</span>
              <PrivacyChip level={decisionToLevel(decision)} />
              {/* The engine's sentence, verbatim. */}
              <p className={styles.consequence}>{explainDecision(decision)}</p>
              {/* The row IS the door. The picker that used to sit above these rows made
                  them decorative; making them the control removes the duplicate without
                  removing a way in. The current audience gets a state, not a dead button:
                  a disabled control here would read as "this person cannot be previewed". */}
              {viewing ? (
                <p className={styles.viewingNow}>You are viewing as {name} now</p>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className={styles.preview}
                  onClick={() => preview(option)}
                >
                  View as {name}
                </Button>
              )}
            </div>
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
              router.push(audienceHref(params.toString(), 'owner'))
            }}
          >
            Back to my own view
          </Button>
        )}

        <ButtonLink
          variant="outline"
          size="sm"
          className={styles.settingsLink}
          href="/settings#visibility"
        >
          Adjust in Settings
        </ButtonLink>
      </div>
    </dialog>
  )
}
