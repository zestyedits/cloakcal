'use client'

import { useMemo } from 'react'
import { decisionToLevel, type VisibilityRule } from '@cloakcal/policy'
import type { AudienceOption } from '@/lib/audiences'
import { useCloakedLabels } from '../use-cloaked-labels'
import { ButtonLink } from '../ui/button'
import { PrivacyChip } from '../ui/privacy-chip'
import { VisibilityControl, workspaceDecisionFor } from '../visibility-control'
import styles from './settings.module.css'

/**
 * Workspace-level visibility defaults for the audiences that have no page of their own:
 * anyone with the link, and each group. A PERSON's rule moved into their contact file at
 * /people/[contactId] when the People area became the book — deciding what Sarah sees
 * belongs next to the preview of what Sarah sees, not in a settings card two screens away.
 * Each person still gets a row here, as a signpost: their engine-decided level and the
 * link across to the file that owns the control.
 *
 * The control itself is the shared VisibilityControl, so this card and the file cannot
 * drift; the chip on a signpost row is `decisionToLevel(evaluate(...))` — the engine is
 * the only interpreter (rule 3), here as everywhere.
 */
export function VisibilitySection({
  workspaceId,
  fixtureMode,
  audiences,
  rules,
  groupsByContact,
}: {
  workspaceId: string | null
  fixtureMode: boolean
  audiences: readonly AudienceOption[]
  rules: readonly VisibilityRule[]
  groupsByContact: Readonly<Record<string, readonly string[]>>
}) {
  // Owner is not an audience you set rules for; everyone else is.
  const rows = audiences.filter((a) => a.kind !== 'owner')
  const contacts = rows.filter((a) => a.kind === 'individual')
  const here = rows.filter((a) => a.kind === 'public' || a.kind === 'group')

  const contactNames = useCloakedLabels('contact', contacts.map((a) => a.id), 'name')
  const groupNames = useCloakedLabels(
    'contact_group',
    here.filter((a) => a.kind === 'group').map((a) => a.id),
    'label',
  )

  // Stable per render pass: time-conditional rules (revealAt/expiresAt) evaluate against
  // ONE instant, not a drifting clock.
  const now = useMemo(() => new Date().toISOString(), [])

  const nameOf = (option: AudienceOption): string => {
    if (option.kind === 'public') return 'Anyone with the link'
    const name = option.kind === 'group' ? groupNames[option.id] : contactNames[option.id]
    if (name !== undefined && name !== '') {
      return option.kind === 'group' ? `Anyone in ${name}` : name
    }
    return `${option.kind === 'group' ? 'Group' : 'Contact'} ${option.id.slice(0, 8)}`
  }

  return (
    <>
      <p className={styles.sectionLede}>
        What the link and each group see of your events unless an event says otherwise.
        Nobody sees anything until you choose to show them. No rule means hidden. Rules
        for a person live in their file, under People.
      </p>

      {workspaceId === null ? (
        <p className={styles.lockedNote}>
          {fixtureMode
            ? 'Demo data. Sign in to set visibility.'
            : 'Available once your calendar is set up.'}
        </p>
      ) : rows.length <= 1 ? (
        <p className={styles.rowNote}>Add people first. Visibility is decided per person.</p>
      ) : (
        <>
          {here.map((option) => (
            <div key={option.id} className={styles.row}>
              <span className={styles.rowLabel}>{nameOf(option)}</span>
              <VisibilityControl
                option={option}
                name={nameOf(option)}
                workspaceId={workspaceId}
                demo={fixtureMode}
                rules={rules}
                groupsByContact={groupsByContact}
              />
            </div>
          ))}

          {contacts.map((option) => {
            const level = decisionToLevel(
              workspaceDecisionFor(option, workspaceId, rules, groupsByContact, now),
            )
            return (
              <div key={option.id} className={styles.row}>
                <span className={styles.rowLabel}>{nameOf(option)}</span>
                <PrivacyChip level={level} />
                <ButtonLink
                  variant="ghost"
                  size="sm"
                  href={{ pathname: `/people/${option.id}` }}
                >
                  Open file
                </ButtonLink>
              </div>
            )
          })}
        </>
      )}
    </>
  )
}
