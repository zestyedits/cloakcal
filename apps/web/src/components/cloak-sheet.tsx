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
import type { AudienceOption } from '@/lib/audiences'
import { ViewAsBar } from './view-as-bar'
import { useCloakedLabels } from './use-cloaked-labels'
import { PrivacyChip } from './ui/privacy-chip'
import { Button, ButtonLink } from './ui/button'
import sheetStyles from './event-sheet.module.css'
import styles from './cloak-sheet.module.css'

/**
 * The Cloak destination — the centre slot of the bottom nav, per the board: privacy is a
 * place you go, not a setting buried in an event.
 *
 * What lives here: View As (finally thumb-reachable on mobile), and one line per audience
 * saying what they see of a rule-less event — level chip plus the ENGINE'S OWN sentence.
 * Same discipline as the settings section: `explainDecision(evaluate(...))`, never a
 * restatement, because rule 3 allows exactly one interpreter of a visibility decision.
 *
 * Client state and a native <dialog>, like the event sheets: mounting is opening, no exit
 * choreography (the close-in-cleanup trap), Escape and backdrop handled by the platform.
 */
export function CloakSheet({
  audiences,
  currentAudience,
  withheldCount,
  workspaceRules,
  groupsByContact,
  onClose,
}: {
  audiences: readonly AudienceOption[]
  currentAudience: string
  withheldCount: number
  workspaceRules: readonly VisibilityRule[]
  groupsByContact: Readonly<Record<string, readonly string[]>>
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (dialog !== null && !dialog.open) dialog.showModal()
  }, [])

  const rows = audiences.filter((a) => a.kind !== 'owner')
  const contactNames = useCloakedLabels(
    'contact',
    rows.filter((a) => a.kind === 'individual').map((a) => a.id),
    'name',
  )
  const groupNames = useCloakedLabels(
    'contact_group',
    rows.filter((a) => a.kind === 'group').map((a) => a.id),
    'label',
  )

  const now = useMemo(() => new Date().toISOString(), [])

  const nameOf = (option: AudienceOption): string => {
    if (option.kind === 'public') return 'Anyone with the link'
    const name = option.kind === 'group' ? groupNames[option.id] : contactNames[option.id]
    if (name !== undefined && name !== '') {
      return option.kind === 'group' ? `Anyone in ${name}` : name
    }
    return `${option.kind === 'group' ? 'Group' : 'Contact'} ${option.id.slice(0, 8)}`
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
          Who sees what. Check any view of your calendar, and what each person gets by
          default.
        </p>

        <ViewAsBar
          audiences={audiences}
          current={currentAudience}
          withheldCount={withheldCount}
        />

        {rows.map((option) => {
          const decision = decisionFor(option)
          return (
            <div key={option.id} className={styles.audience}>
              <span className={styles.audienceName}>{nameOf(option)}</span>
              <PrivacyChip level={decisionToLevel(decision)} />
              {/* The engine's sentence, verbatim. */}
              <p className={styles.consequence}>{explainDecision(decision)}</p>
            </div>
          )
        })}

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
