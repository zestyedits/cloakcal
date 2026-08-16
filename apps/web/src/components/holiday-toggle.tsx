'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { HOLIDAY_REGIONS, type HolidayPreference, type HolidayRegion } from '@cloakcal/domain'
import { rpcErrorMessage } from '@/lib/rpc-error'
import { canSavePrefs, saveCalendarPrefs, type PrefsTarget } from '@/lib/save-prefs'
import { InlineError } from './ui/inline-error'
import styles from './holiday-toggle.module.css'

/**
 * Holidays, switched on and off from the sidebar, in the calendars list.
 *
 * WHY IT LIVES WITH THE CALENDARS and not in the Cloak sheet or the header. A holiday layer
 * behaves exactly like a calendar you can hide: a named set of days, on or off, that is not
 * yours and that you did not create. Every other product puts it in that list, so that is
 * where people look for it, and putting it there costs no new chrome — the section, the row
 * shape and the swatch already exist.
 *
 * It is NOT a calendar, though, and the row says so by what it lacks: no colour swatch in the
 * palette the real calendars use, and no privacy chip anywhere near it. A holiday has no
 * privacy level — it is public by definition, the same date for everyone — and rendering one
 * in the four learned privacy inks would teach that a public date and a cloaked event are the
 * same kind of thing. That distinction is the whole product.
 *
 * OFF IS `'off'`, NOT A CLEARED REGION. The stored preference is a tri-state (auto / off /
 * a code), so switching off here remembers nothing and switching back on returns to `auto`
 * rather than to whatever was chosen in Settings. That is the one wart of the tri-state and
 * it is the right trade: the alternative is a fourth state ("off, but remember GB"), which
 * exists to serve a user who set a region explicitly and then turned the whole thing off,
 * which is close to nobody.
 *
 * Hidden when there is nowhere to save — a signed-in user with no workspace yet, or a
 * restricted audience previewing someone else's calendar, which is not their setting to make.
 * Same rule as DefaultViewControl, and for the same reason.
 */
export function HolidayToggle({
  preference,
  region,
  target,
}: {
  /** The stored tri-state. */
  preference: HolidayPreference
  /** What it resolved to, or null when the answer is "show none". */
  region: HolidayRegion | null
  target: PrefsTarget
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!canSavePrefs(target)) return null

  const on = preference !== 'off'
  const label = HOLIDAY_REGIONS.find((r) => r.id === region)?.label

  const toggle = async () => {
    setBusy(true)
    setError(null)
    try {
      await saveCalendarPrefs(target, { holidayRegion: on ? 'off' : 'auto' })
      router.refresh()
    } catch (caught) {
      setError(rpcErrorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  /*
   * The state a user most needs explained is "on, but showing nothing": `auto` with a
   * timezone that maps to no region we ship. Saying so on the row is the difference between
   * a setting that looks broken and one that tells you to go and pick a country.
   */
  const detail = !on
    ? 'Off'
    : label !== undefined
      ? label
      : 'No region for your timezone yet'

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={styles.row}
        role="switch"
        aria-checked={on}
        aria-disabled={busy || undefined}
        onClick={() => void toggle()}
      >
        {/* A shape change, not a colour one, so the state survives both themes and does not
            lean on a hue anyone has to distinguish. Same reasoning as the default-view
            bookmark and the calendar swatches. */}
        <span className={styles.mark} data-on={on || undefined} aria-hidden="true">
          <svg viewBox="0 0 16 16" width="12" height="12" focusable="false">
            <path
              d="M3.5 8.5 6.5 11.5 12.5 5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className={styles.text}>
          <span className={styles.name}>Holidays</span>
          <span className={styles.detail}>{detail}</span>
        </span>
      </button>
      <InlineError>{error}</InlineError>
    </div>
  )
}
