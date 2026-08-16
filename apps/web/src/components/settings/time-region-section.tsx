'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  HOLIDAY_REGIONS,
  resolveHolidayRegion,
  type HolidayPreference,
  type HolidayRegion,
} from '@cloakcal/domain'
import { rpcErrorMessage } from '@/lib/rpc-error'
import { canSavePrefs, saveCalendarPrefs } from '@/lib/save-prefs'
import type { CalendarPrefs } from '@/server/settings'
import type { WeekStart } from '@/server/range'
import { InlineError } from '../ui/inline-error'
import styles from './settings.module.css'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Region id to plain label, for the one place that names a resolved region inline. */
const REGION_LABELS: Record<HolidayRegion, string> = Object.fromEntries(
  HOLIDAY_REGIONS.map((region) => [region.id, region.label]),
) as Record<HolidayRegion, string>

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
 *
 * Default view and keyboard shortcuts used to live here and now sit under Appearance,
 * which is what they are about. This card is time and region and nothing else.
 */
export function TimeRegionSection({
  workspaceId,
  fixtureMode,
  timezone,
  weekStart,
  holidayRegion,
}: {
  workspaceId: string | null
  fixtureMode: boolean
  timezone: string | null
  weekStart: WeekStart
  /** The stored tri-state: auto, off, or an explicit region. */
  holidayRegion: HolidayPreference
}) {
  const router = useRouter()

  // What `auto` currently resolves to, so the option can say so rather than leaving the
  // user to discover that their timezone maps to nothing we ship.
  const resolved = resolveHolidayRegion('auto', timezone ?? 'America/New_York')
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

  const target = { demo: fixtureMode, workspaceId }
  const disabled = !canSavePrefs(target) || busy

  const save = async (patch: Partial<CalendarPrefs>) => {
    setBusy(true)
    setError(null)
    try {
      await saveCalendarPrefs(target, patch)
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
        Events keep their local times: a 9:00 meeting stays at 9:00 wherever you are.
        Changing these reframes how the calendar is drawn, never when anything happens.
      </p>

      <InlineError>{error}</InlineError>

      {!fixtureMode && workspaceId === null && (
        <p className={styles.lockedNote}>These arrive once your calendar is set up.</p>
      )}

      <div className={styles.field}>
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

      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="settings-week-start">
          Week starts on
        </label>
        <select
          id="settings-week-start"
          className={styles.select}
          value={weekStart}
          disabled={disabled}
          onChange={(event) => void save({ weekStart: Number(event.target.value) as WeekStart })}
        >
          {WEEKDAYS.map((day, index) => (
            <option key={day} value={index}>
              {day}
            </option>
          ))}
        </select>
      </div>

      {/*
        Holidays belong in this card rather than under Appearance, because the question is
        WHICH COUNTRY, not how the calendar looks. The sidebar switch is the on/off; this is
        where you say whose holidays.
      */}
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="settings-holidays">
          Holidays
        </label>
        <select
          id="settings-holidays"
          className={styles.select}
          value={holidayRegion}
          disabled={disabled}
          onChange={(event) =>
            void save({ holidayRegion: event.target.value as HolidayPreference })
          }
        >
          {/* `auto` names what it resolved to, so the option is a statement rather than a
              promise: "Match my timezone (United States)" versus the bare word, which leaves
              the user to guess whether it found anything. */}
          <option value="auto">
            {resolved === null
              ? 'Match my timezone (no match yet)'
              : `Match my timezone (${REGION_LABELS[resolved]})`}
          </option>
          <option value="off">Do not show holidays</option>
          {HOLIDAY_REGIONS.map((region) => (
            <option key={region.id} value={region.id}>
              {region.label}
              {'note' in region ? ` (${region.note})` : ''}
            </option>
          ))}
        </select>
        <p className={styles.fieldNote}>
          Public holidays and the days people mark, drawn from a built-in list. Nothing is
          fetched and nothing about your calendar leaves the browser to work out which ones
          to show.
        </p>
      </div>
    </>
  )
}
