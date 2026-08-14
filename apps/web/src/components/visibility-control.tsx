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
import { Button } from './ui/button'
import { Icon, type IconName } from './ui/icons'
import { InlineError } from './ui/inline-error'
import { PrivacyChip } from './ui/privacy-chip'
import styles from './visibility-control.module.css'

/**
 * The workspace-level visibility control for ONE audience, extracted from the Settings
 * Visibility card when per-contact rules moved into each contact's file. Two homes render
 * it now — Settings for public and groups, the file for a person — and a shared component
 * is what keeps them the same control rather than two that drift.
 *
 * THE COPY COMES FROM THE ENGINE, NOT FROM THIS FILE. The current level is
 * `decisionToLevel(evaluate(...))` — the same evaluate the server redacts with — and the
 * sentence is `explainDecision` of that decision. packages/policy is the only interpreter
 * (rule 3); copy that restates a rule in its own words is the kind of drift nothing notices.
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

/** The per-field toggles the CUSTOMIZE section offers. */
const CUSTOM_FIELDS = ['title', 'location', 'notes', 'attendees'] as const
const FIELD_LABELS: Record<(typeof CUSTOM_FIELDS)[number], string> = {
  title: 'Title',
  location: 'Location',
  notes: 'Notes',
  attendees: 'Attendees',
}

/** What this audience sees of a rule-less event: the workspace default, engine-decided. */
export function workspaceDecisionFor(
  option: AudienceOption,
  workspaceId: string | null,
  rules: readonly VisibilityRule[],
  groupsByContact: Readonly<Record<string, readonly string[]>>,
  now: string,
) {
  const viewer: ViewerIdentity =
    option.kind === 'public'
      ? { kind: 'public' }
      : option.kind === 'group'
        ? // A group previews as a person whose only membership is that group — the same
          // modelling the server's redaction uses.
          { kind: 'individual', contactId: `group:${option.id}`, groupIds: [option.id] }
        : {
            kind: 'individual',
            contactId: option.id,
            groupIds: groupsByContact[option.id] ?? [],
          }
  const input: EvaluateInput = {
    event: {
      eventId: '00000000-0000-4000-8000-000000000000',
      workspaceId: workspaceId ?? 'preview',
      lifecycle: 'active',
      rules: [],
    },
    viewer,
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

export function VisibilityControl({
  option,
  name,
  workspaceId,
  demo,
  rules,
  groupsByContact,
}: {
  option: AudienceOption
  /** Decrypted display name, for the group label only. Never rendered by this component
      as content — the caller owns the row's name; this one names the control for AT. */
  name: string
  workspaceId: string | null
  /** Fixture mode: the control renders honestly disabled and every write refuses early. */
  demo: boolean
  rules: readonly VisibilityRule[]
  groupsByContact: Readonly<Record<string, readonly string[]>>
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [customizing, setCustomizing] = useState(false)

  // Stable per render pass: time-conditional rules (revealAt/expiresAt) evaluate against
  // ONE instant, not a drifting clock.
  const now = useMemo(() => new Date().toISOString(), [])

  const decision = workspaceDecisionFor(option, workspaceId, rules, groupsByContact, now)
  const level = decisionToLevel(decision)

  const rule = rules.find(
    (candidate) =>
      candidate.scope === 'workspace' &&
      (option.kind === 'public'
        ? candidate.audience === 'public'
        : candidate.audience === (option.kind === 'group' ? 'group' : 'individual') &&
          candidate.audienceRef === option.id),
  )

  const disabled = busy || demo || workspaceId === null

  const run = async (action: () => Promise<void>) => {
    // The demo cannot write, structurally (no session, anon revoked); this early return
    // keeps the property in the code rather than in one button's disabled attribute.
    if (demo || workspaceId === null) return
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

  const setPreset = (preset: PrivacyLevel) =>
    run(async () => {
      const { error: rpcError } = await supabaseBrowser().rpc('set_visibility_rule', {
        p_workspace_id: workspaceId!,
        p_audience: option.kind === 'public' ? 'public' : option.kind,
        p_audience_ref: option.kind === 'public' ? null : option.id,
        p_time_vis: PRESET_TIME[preset],
        p_fields: PRESET_FIELDS[preset],
      })
      if (rpcError !== null) throw rpcError
    })

  const setCustomField = (field: string, visible: boolean) =>
    run(async () => {
      const fields: Partial<Record<string, FieldVisibility>> = {
        ...(rule?.fields ?? PRESET_FIELDS.limited),
        [field]: visible ? 'visible' : 'hidden',
      }
      const { error: rpcError } = await supabaseBrowser().rpc('set_visibility_rule', {
        p_workspace_id: workspaceId!,
        p_audience: option.kind === 'public' ? 'public' : option.kind,
        p_audience_ref: option.kind === 'public' ? null : option.id,
        // Field toggles only make sense with exact time; the engine ignores fields under
        // busy/hidden, so writing them there would store settings that do nothing.
        p_time_vis: 'exact',
        p_fields: fields,
      })
      if (rpcError !== null) throw rpcError
    })

  const reset = () =>
    run(async () => {
      if (rule === undefined) return
      const { error: rpcError } = await supabaseBrowser().rpc('delete_visibility_rule', {
        p_rule_id: rule.id,
      })
      if (rpcError !== null) throw rpcError
    })

  return (
    <div className={styles.control}>
      <PrivacyChip level={level} />

      <InlineError>{error}</InlineError>

      <div className={styles.presets} role="group" aria-label={`Visibility for ${name}`}>
        {PRIVACY_ORDER.map((preset) => (
          <button
            key={preset}
            type="button"
            className={styles.preset}
            aria-pressed={level === preset}
            disabled={disabled}
            onClick={() => {
              if (level !== preset) void setPreset(preset)
            }}
          >
            <Icon name={PRIVACY_LEVELS[preset].icon as IconName} size={12} />
            {PRIVACY_LEVELS[preset].label}
          </button>
        ))}
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-expanded={customizing}
          onClick={() => setCustomizing((open) => !open)}
        >
          Customize
        </Button>
        {rule !== undefined && (
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => void reset()}>
            Reset
          </Button>
        )}
      </div>

      {/* The engine's own sentence — never restated here. */}
      <p className={styles.note}>
        {rule === undefined ? 'Hidden (default): ' : ''}
        {explainDecision(decision)}
      </p>

      {customizing && (
        <div className={styles.customize}>
          {CUSTOM_FIELDS.map((field) => {
            const visible = decision.time === 'exact' && decision.fields[field] === 'visible'
            return (
              <label key={field} className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={visible}
                  disabled={disabled}
                  onChange={() => void setCustomField(field, !visible)}
                />
                {FIELD_LABELS[field]}
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}
