'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabaseBrowser } from '@/lib/supabase/client'
import { rpcErrorMessage } from '@/lib/rpc-error'
import { InlineError } from '../ui/inline-error'
import styles from './settings.module.css'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const VIEWS = [
  ['agenda', 'Agenda'],
  ['week', 'Week'],
  ['day', 'Day'],
  ['month', 'Month'],
] as const

/**
 * Timezone and week start — Tier A preferences, live even while the calendar is locked.
 *
 * The zone list is `Intl.supportedValuesOf`, which is ALSO the validation: the RPC's CHECK
 * is a shape check only (0018's PGlite reasoning), so offering exactly the zones this
 * runtime supports is what keeps a garbage value out. A native select carries ~420 options
 * fine and is the right control at 390px.
 *
 * On success, `router.refresh()` — the server re-frames the week in the new zone, which is
 * the visible proof the setting did something (ADR 0001: display framing only; a 9:00
 * meeting stays at 9:00).
 */
export function TimeRegionSection({
  workspaceId,
  fixtureMode,
  timezone,
  weekStart,
  defaultView,
  keyboardShortcuts,
}: {
  workspaceId: string | null
  fixtureMode: boolean
  timezone: string | null
  weekStart: number
  defaultView: string
  keyboardShortcuts: boolean
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const zones = useMemo(() => {
    const supported = Intl.supportedValuesOf('timeZone')
    // A stored zone this runtime does not know still needs to be visible as the current
    // value, or the select would silently claim a different setting than the one saved.
    return timezone !== null && !supported.includes(timezone)
      ? [timezone, ...supported]
      : supported
  }, [timezone])

  const disabled = workspaceId === null || busy

  const save = async (patch: {
    timezone?: string
    weekStart?: number
    defaultView?: string
    keyboardShortcuts?: boolean
  }) => {
    if (workspaceId === null) return
    setBusy(true)
    setError(null)
    try {
      const { error: rpcError } = await supabaseBrowser().rpc('set_workspace_prefs', {
        p_workspace_id: workspaceId,
        p_timezone: patch.timezone ?? null,
        p_week_start: patch.weekStart ?? null,
        p_default_view: patch.defaultView ?? null,
        p_keyboard_shortcuts: patch.keyboardShortcuts ?? null,
      })
      if (rpcError !== null) throw rpcError
      router.refresh()
    } catch (caught) {
      setError(rpcErrorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <p className={styles.sectionLede}>
        Changes how your calendar is displayed. Events keep their local times: a 9:00
        meeting stays at 9:00.
      </p>

      <InlineError>{error}</InlineError>

      {workspaceId === null && (
        <p className={styles.lockedNote}>
          {fixtureMode
            ? 'Demo data. Sign in to change these.'
            : 'These arrive once your calendar is set up.'}
        </p>
      )}

      <div className={styles.controls}>
        <div>
          <label className={styles.fieldLabel} htmlFor="settings-timezone">
            Timezone
          </label>
          <select
            id="settings-timezone"
            className={styles.select}
            value={timezone ?? 'America/New_York'}
            disabled={disabled}
            onChange={(event) => void save({ timezone: event.target.value })}
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={styles.fieldLabel} htmlFor="settings-week-start">
            Week starts on
          </label>
          <select
            id="settings-week-start"
            className={styles.select}
            value={weekStart}
            disabled={disabled}
            onChange={(event) => void save({ weekStart: Number(event.target.value) })}
          >
            {WEEKDAYS.map((day, index) => (
              <option key={day} value={index}>
                {day}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={styles.fieldLabel} htmlFor="settings-default-view">
            Opens on
          </label>
          <select
            id="settings-default-view"
            className={styles.select}
            value={defaultView}
            disabled={disabled}
            onChange={(event) => void save({ defaultView: event.target.value })}
          >
            {VIEWS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={styles.fieldLabel} htmlFor="settings-keyboard">
            Keyboard shortcuts
          </label>
          {/* A select, not a bare checkbox: same control family as the rest of the card,
              and the two options state their consequence instead of a naked on/off. Off is
              the default on purpose — single-key shortcuts are opt-in (WCAG 2.1.4), and
              speech-input users trigger them with ordinary dictation. */}
          <select
            id="settings-keyboard"
            className={styles.select}
            value={keyboardShortcuts ? 'on' : 'off'}
            disabled={disabled}
            onChange={(event) => void save({ keyboardShortcuts: event.target.value === 'on' })}
          >
            <option value="off">Off</option>
            <option value="on">On: t, arrows, j/k, 1-4, n, ?</option>
          </select>
        </div>
      </div>
    </>
  )
}
