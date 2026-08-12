'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  STANDARD_FIELDS,
  decisionToLevel,
  evaluate,
  explainDecision,
  type EvaluateInput,
  type FieldVisibility,
  type ViewerIdentity,
  type VisibilityRule,
} from '@cloakcal/policy'
import type { PrivacyLevel } from '@cloakcal/ui'
import { PRIVACY_LEVELS, PRIVACY_ORDER } from '@cloakcal/ui'
import { supabaseBrowser } from '@/lib/supabase/client'
import { rpcErrorMessage } from '@/lib/rpc-error'
import type { AudienceOption } from '@/lib/audiences'
import { useCloakedLabels } from '../use-cloaked-labels'
import { Button } from '../ui/button'
import { Icon, type IconName } from '../ui/icons'
import { InlineError } from '../ui/inline-error'
import { PrivacyChip } from '../ui/privacy-chip'
import styles from './settings.module.css'

/**
 * Workspace-level visibility defaults: what each audience sees when an event has no rule
 * of its own.
 *
 * THE COPY COMES FROM THE ENGINE, NOT FROM THIS FILE. Each row's summary is
 * `explainDecision(evaluate(...))` — the same evaluate the server redacts with — and the
 * current level is `decisionToLevel` of that decision. This component never restates a
 * rule in its own words; packages/policy is the only interpreter (rule 3), and copy that
 * duplicates engine logic is the kind of drift nothing notices.
 *
 * An audience with NO rule shows "Hidden (default)": the engine's deny-by-default,
 * distinguished from a written Hidden rule because "you chose this" and "nothing was ever
 * chosen" are different facts, and Reset only exists for the first.
 *
 * No version guard on rules, per 0017: pressing a preset twice is not a conflict.
 */

const PRESET_FIELDS: Record<PrivacyLevel, Partial<Record<string, FieldVisibility>>> = {
  full: Object.fromEntries(STANDARD_FIELDS.map((f) => [f, 'visible'])),
  limited: { title: 'visible' },
  busy: {},
  hidden: {},
}

const PRESET_TIME: Record<PrivacyLevel, 'exact' | 'busy' | 'hidden'> = {
  full: 'exact',
  limited: 'exact',
  busy: 'busy',
  hidden: 'hidden',
}

/** The per-field toggles the sheet's CUSTOMIZE section offers. */
const CUSTOM_FIELDS = ['title', 'location', 'notes', 'attendees'] as const

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
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [customizing, setCustomizing] = useState<string | null>(null)

  // Owner is not an audience you set rules for; everyone else is.
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

  const viewerOf = (option: AudienceOption): ViewerIdentity => {
    if (option.kind === 'public') return { kind: 'public' }
    if (option.kind === 'group') {
      // A group previews as a person whose only membership is that group — the same
      // modelling the server's redaction uses.
      return { kind: 'individual', contactId: `group:${option.id}`, groupIds: [option.id] }
    }
    return {
      kind: 'individual',
      contactId: option.id,
      groupIds: groupsByContact[option.id] ?? [],
    }
  }

  /** What this audience sees of a rule-less event — the workspace default, engine-decided. */
  const decisionFor = (option: AudienceOption) => {
    const input: EvaluateInput = {
      event: {
        eventId: '00000000-0000-4000-8000-000000000000',
        workspaceId: workspaceId ?? 'preview',
        lifecycle: 'active',
        rules: [],
      },
      viewer: viewerOf(option),
      workspace: {
        workspaceId: workspaceId ?? 'preview',
        timeVis: 'hidden',
        fields: {},
        rules: [...rules],
      },
      now,
      policyVersion: 'v1',
    }
    return evaluate(input)
  }

  const ruleFor = (option: AudienceOption): VisibilityRule | undefined =>
    rules.find(
      (rule) =>
        rule.scope === 'workspace' &&
        (option.kind === 'public'
          ? rule.audience === 'public'
          : rule.audience === (option.kind === 'group' ? 'group' : 'individual') &&
            rule.audienceRef === option.id),
    )

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      router.refresh()
    } catch (caught) {
      setError(rpcErrorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  const setPreset = (option: AudienceOption, level: PrivacyLevel) =>
    run(async () => {
      if (workspaceId === null) return
      const { error: rpcError } = await supabaseBrowser().rpc('set_visibility_rule', {
        p_workspace_id: workspaceId,
        p_audience: option.kind === 'public' ? 'public' : option.kind,
        p_audience_ref: option.kind === 'public' ? null : option.id,
        p_time_vis: PRESET_TIME[level],
        p_fields: PRESET_FIELDS[level],
      })
      if (rpcError !== null) throw rpcError
    })

  const setCustomField = (option: AudienceOption, field: string, visible: boolean) =>
    run(async () => {
      if (workspaceId === null) return
      const current = ruleFor(option)
      const fields: Partial<Record<string, FieldVisibility>> = {
        ...(current?.fields ?? PRESET_FIELDS.limited),
        [field]: visible ? 'visible' : 'hidden',
      }
      const { error: rpcError } = await supabaseBrowser().rpc('set_visibility_rule', {
        p_workspace_id: workspaceId,
        p_audience: option.kind === 'public' ? 'public' : option.kind,
        p_audience_ref: option.kind === 'public' ? null : option.id,
        // Field toggles only make sense with exact time; the engine ignores fields under
        // busy/hidden, so writing them there would store settings that do nothing.
        p_time_vis: 'exact',
        p_fields: fields,
      })
      if (rpcError !== null) throw rpcError
    })

  const reset = (option: AudienceOption) =>
    run(async () => {
      const rule = ruleFor(option)
      if (rule === undefined) return
      const { error: rpcError } = await supabaseBrowser().rpc('delete_visibility_rule', {
        p_rule_id: rule.id,
      })
      if (rpcError !== null) throw rpcError
    })

  return (
    <>
      <p className={styles.sectionLede}>
        What each person sees of your events unless an event says otherwise. Nobody sees
        anything until you choose to show them — no rule means hidden.
      </p>

      <InlineError>{error}</InlineError>

      {workspaceId === null ? (
        <p className={styles.lockedNote}>
          {fixtureMode
            ? 'Demo data — sign in to set visibility.'
            : 'Available once your calendar is set up.'}
        </p>
      ) : rows.length <= 1 ? (
        <p className={styles.rowNote}>Add people first — visibility is decided per person.</p>
      ) : (
        rows.map((option) => {
          const decision = decisionFor(option)
          const level = decisionToLevel(decision)
          const rule = ruleFor(option)

          return (
            <div key={option.id} className={styles.row}>
              <span className={styles.rowLabel}>{nameOf(option)}</span>
              <PrivacyChip level={level} />

              <div className={styles.presets} role="group" aria-label={`Visibility for ${nameOf(option)}`}>
                {PRIVACY_ORDER.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    className={styles.preset}
                    aria-pressed={level === preset}
                    disabled={busy}
                    onClick={() => {
                      if (level !== preset) void setPreset(option, preset)
                    }}
                  >
                    <Icon name={PRIVACY_LEVELS[preset].icon as IconName} size={12} />
                    {PRIVACY_LEVELS[preset].label}
                  </button>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-expanded={customizing === option.id}
                  onClick={() => setCustomizing(customizing === option.id ? null : option.id)}
                >
                  Customize
                </Button>
                {rule !== undefined && (
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => void reset(option)}>
                    Reset
                  </Button>
                )}
              </div>

              {/* The engine's own sentence — never restated here. */}
              <p className={styles.rowNote}>
                {rule === undefined ? 'Hidden (default) — ' : ''}
                {explainDecision(decision)}
              </p>

              {customizing === option.id && (
                <div style={{ width: '100%' }}>
                  {CUSTOM_FIELDS.map((field) => {
                    const visible = decision.time === 'exact' && decision.fields[field] === 'visible'
                    return (
                      <label key={field} className={styles.checkboxRow}>
                        <input
                          type="checkbox"
                          checked={visible}
                          disabled={busy}
                          onChange={() => void setCustomField(option, field, !visible)}
                        />
                        {field === 'title'
                          ? 'Title'
                          : field === 'location'
                            ? 'Location'
                            : field === 'notes'
                              ? 'Notes'
                              : 'Attendees'}
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })
      )}
    </>
  )
}
