'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabaseBrowser } from '@/lib/supabase/client'
import { rpcErrorMessage } from '@/lib/rpc-error'
import { InlineError } from '../ui/inline-error'
import styles from './settings.module.css'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

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
}: {
  workspaceId: string | null
  fixtureMode: boolean
  timezone: string | null
  weekStart: number
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

  const save = async (patch: { timezone?: string; weekStart?: number }) => {
    if (workspaceId === null) return
    setBusy(true)
    setError(null)
    try {
      const { error: rpcError } = await supabaseBrowser().rpc('set_workspace_prefs', {
        p_workspace_id: workspaceId,
        p_timezone: patch.timezone ?? null,
        p_week_start: patch.weekStart ?? null,
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
    <section id="time-region" className={styles.section} aria-labelledby="time-region-title">
      <h2 id="time-region-title" className={styles.sectionTitle}>
        Time &amp; region
      </h2>
      <p className={styles.sectionLede}>
        Changes how your calendar is displayed. Events keep their local times — a 9:00
        meeting stays at 9:00.
      </p>

      <InlineError>{error}</InlineError>

      {workspaceId === null && (
        <p className={styles.lockedNote}>
          {fixtureMode
            ? 'Demo data — sign in to change these.'
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
      </div>
    </section>
  )
}
