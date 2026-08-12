'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
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
import { PRIVACY_LEVELS, PRIVACY_ORDER, type PrivacyLevel } from '@cloakcal/ui'
import { supabaseBrowser } from '@/lib/supabase/client'
import { rpcErrorMessage } from '@/lib/rpc-error'
import type { AudienceOption } from '@/lib/audiences'
import { useCloakedLabels } from './use-cloaked-labels'
import { Button } from './ui/button'
import { Icon, type IconName } from './ui/icons'
import { InlineError } from './ui/inline-error'
import { PrivacyChip } from './ui/privacy-chip'
import sheetStyles from './event-sheet.module.css'
import styles from './visibility-sheet.module.css'

/**
 * Event Visibility — the third of the three screens the brand board actually specifies,
 * and the one that makes the product's pitch a control instead of a demonstration:
 * "show different people different amounts of THIS event."
 *
 * Same engine discipline as everywhere else: the current state of each audience is
 * `evaluate()` with this event's stored rules in play, the chip is `decisionToLevel`, the
 * sentence is `explainDecision` — never restated. Saving writes an EVENT-scoped rule via
 * `set_visibility_rule(p_event_id)`, which the engine already resolves above the
 * workspace default (D8); "Use default" deletes the override and the row falls back,
 * visibly, to whatever Settings says.
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

const CUSTOM_FIELDS = ['title', 'location', 'notes', 'attendees'] as const
const FIELD_LABELS: Record<(typeof CUSTOM_FIELDS)[number], string> = {
  title: 'Title',
  location: 'Location',
  notes: 'Notes',
  attendees: 'Attendees',
}

export function VisibilitySheet({
  eventId,
  audiences,
  workspaceRules,
  eventRules,
  groupsByContact,
  onClose,
}: {
  eventId: string
  audiences: readonly AudienceOption[]
  workspaceRules: readonly VisibilityRule[]
  /** Event-scoped rules already stored for THIS event. */
  eventRules: readonly VisibilityRule[]
  groupsByContact: Readonly<Record<string, readonly string[]>>
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const router = useRouter()

  const [tab, setTab] = useState<'people' | 'groups'>('people')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [customizing, setCustomizing] = useState<string | null>(null)
  // Resolved once, client-side, exactly as the compose sheet does — the redacted payload
  // deliberately never carries a workspace id.
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)

  useEffect(() => {
    const dialog = ref.current
    if (dialog !== null && !dialog.open) dialog.showModal()
  }, [])

  useEffect(() => {
    void (async () => {
      const { data } = await supabaseBrowser()
        .from('workspaces')
        .select('id')
        .eq('lifecycle', 'active')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle<{ id: string }>()
      if (data !== null) setWorkspaceId(data.id)
    })()
  }, [])

  const contacts = audiences.filter((a) => a.kind === 'individual')
  const groups = audiences.filter((a) => a.kind === 'group')
  const rows = tab === 'people' ? contacts : groups

  const contactNames = useCloakedLabels('contact', contacts.map((c) => c.id), 'name')
  const groupNames = useCloakedLabels('contact_group', groups.map((g) => g.id), 'label')

  const now = useMemo(() => new Date().toISOString(), [])

  const nameOf = (option: AudienceOption): string => {
    const name = option.kind === 'group' ? groupNames[option.id] : contactNames[option.id]
    if (name !== undefined && name !== '') return name
    return `${option.kind === 'group' ? 'Group' : 'Contact'} ${option.id.slice(0, 8)}`
  }

  const decisionFor = (option: AudienceOption) => {
    const viewer: ViewerIdentity =
      option.kind === 'group'
        ? { kind: 'individual', contactId: `group:${option.id}`, groupIds: [option.id] }
        : {
            kind: 'individual',
            contactId: option.id,
            groupIds: groupsByContact[option.id] ?? [],
          }
    const input: EvaluateInput = {
      event: {
        eventId,
        workspaceId: workspaceId ?? 'preview',
        lifecycle: 'active',
        rules: [...eventRules],
      },
      viewer,
      workspace: {
        workspaceId: workspaceId ?? 'preview',
        timeVis: 'hidden',
        fields: {},
        rules: [...workspaceRules],
      },
      now,
      policyVersion: 'v1',
    }
    return evaluate(input)
  }

  const overrideFor = (option: AudienceOption): VisibilityRule | undefined =>
    eventRules.find(
      (rule) =>
        rule.audience === (option.kind === 'group' ? 'group' : 'individual') &&
        rule.audienceRef === option.id,
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
        p_audience: option.kind === 'group' ? 'group' : 'individual',
        p_audience_ref: option.id,
        p_time_vis: PRESET_TIME[level],
        p_fields: PRESET_FIELDS[level],
        p_event_id: eventId,
      })
      if (rpcError !== null) throw rpcError
    })

  const setCustomField = (option: AudienceOption, field: string, visible: boolean) =>
    run(async () => {
      if (workspaceId === null) return
      const current = overrideFor(option)
      const fields: Partial<Record<string, FieldVisibility>> = {
        ...(current?.fields ?? PRESET_FIELDS.limited),
        [field]: visible ? 'visible' : 'hidden',
      }
      const { error: rpcError } = await supabaseBrowser().rpc('set_visibility_rule', {
        p_workspace_id: workspaceId,
        p_audience: option.kind === 'group' ? 'group' : 'individual',
        p_audience_ref: option.id,
        p_time_vis: 'exact',
        p_fields: fields,
        p_event_id: eventId,
      })
      if (rpcError !== null) throw rpcError
    })

  const useDefault = (option: AudienceOption) =>
    run(async () => {
      const override = overrideFor(option)
      if (override === undefined) return
      const { error: rpcError } = await supabaseBrowser().rpc('delete_visibility_rule', {
        p_rule_id: override.id,
      })
      if (rpcError !== null) throw rpcError
    })

  const offline = workspaceId === null

  return (
    <dialog ref={ref} className={sheetStyles.sheet} aria-labelledby={titleId} onClose={onClose}>
      <div className={sheetStyles.body}>
        <div className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            Event visibility
          </h2>
          <Button variant="ghost" size="sm" onClick={() => ref.current?.close()}>
            Close
          </Button>
        </div>

        <p className={styles.lede}>
          Choose what people see for this event. Anything set here overrides their default
          from Settings, for this event only.
        </p>

        <InlineError>{error}</InlineError>

        <div className={styles.tabs} role="tablist" aria-label="Audience kind">
          {(['people', 'groups'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              role="tab"
              aria-selected={tab === kind}
              className={styles.tab}
              onClick={() => setTab(kind)}
            >
              {kind === 'people' ? 'People' : 'Groups'}
            </button>
          ))}
        </div>

        {rows.length === 0 && (
          <p className={styles.note}>
            {tab === 'people'
              ? 'No contacts yet. Add people in Settings first.'
              : 'No groups yet. Create them in Settings first.'}
          </p>
        )}

        {rows.map((option) => {
          const decision = decisionFor(option)
          const level = decisionToLevel(decision)
          const override = overrideFor(option)

          return (
            <div key={option.id} className={styles.audience}>
              <span className={styles.audienceName}>{nameOf(option)}</span>
              <PrivacyChip level={level} />

              <div className={styles.presets} role="group" aria-label={`Visibility for ${nameOf(option)}`}>
                {PRIVACY_ORDER.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    className={styles.preset}
                    aria-pressed={override !== undefined && level === preset}
                    disabled={busy || offline}
                    onClick={() => void setPreset(option, preset)}
                  >
                    <Icon name={PRIVACY_LEVELS[preset].icon as IconName} size={12} />
                    {PRIVACY_LEVELS[preset].label}
                  </button>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || offline}
                  aria-expanded={customizing === option.id}
                  onClick={() => setCustomizing(customizing === option.id ? null : option.id)}
                >
                  Customize
                </Button>
                {override !== undefined && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || offline}
                    onClick={() => void useDefault(option)}
                  >
                    Use default
                  </Button>
                )}
              </div>

              {/* The engine's sentence, with the source of the answer named. */}
              <p className={styles.note}>
                {override === undefined ? 'Their default: ' : 'For this event: '}
                {explainDecision(decision)}
              </p>

              {customizing === option.id && (
                <div className={styles.customize}>
                  {CUSTOM_FIELDS.map((field) => {
                    const visible =
                      decision.time === 'exact' && decision.fields[field] === 'visible'
                    return (
                      <label key={field} className={styles.checkboxRow}>
                        <input
                          type="checkbox"
                          checked={visible}
                          disabled={busy || offline}
                          onChange={() => void setCustomField(option, field, !visible)}
                        />
                        {FIELD_LABELS[field]}
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}

        {offline && audiences.some((a) => a.kind !== 'owner' && a.kind !== 'public') && (
          <p className={styles.note}>Demo data. Sign in to change visibility.</p>
        )}
      </div>
    </dialog>
  )
}
