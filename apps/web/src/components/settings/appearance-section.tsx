'use client'

import { useEffect, useState } from 'react'
import { applyTheme, readStoredTheme, type Theme } from '@/lib/theme'
import { rpcErrorMessage } from '@/lib/rpc-error'
import { canSavePrefs, saveCalendarPrefs } from '@/lib/save-prefs'
import type { CalendarPrefs } from '@/server/settings'
import { CALENDAR_VIEWS, VIEW_LABELS } from '@/lib/calendar-views'
import type { CalendarView } from '../calendar-screen'
import { useRouter } from 'next/navigation'
import { InlineError } from '../ui/inline-error'
import { HOTKEYS, HOTKEY_CAVEAT } from '@/lib/hotkeys'
import styles from './settings.module.css'

/**
 * How the calendar looks and answers you: theme, the view it opens on, the keyboard.
 *
 * Default view and keyboard shortcuts moved here from "Time & region", which was never
 * their subject — a card named for zones and week starts is not where anyone looks for
 * "which view do I open on", and that mis-filing is most of why the preference read as
 * unbuilt. Timezone and week start stayed behind, because those genuinely are time and
 * region.
 *
 * The theme is per-browser and the other two are per-account, which used to be expressed
 * by keeping them in separate cards. A row that states its own scope says it better and in
 * the place it matters, so they sit together and the theme row carries the tag.
 */
export function AppearanceSection({
  workspaceId,
  fixtureMode,
  defaultView,
  keyboardShortcuts,
}: {
  workspaceId: string | null
  fixtureMode: boolean
  defaultView: CalendarView
  keyboardShortcuts: boolean
}) {
  const router = useRouter()
  const [theme, setTheme] = useState<Theme | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // State defers to mount for the same reason the header toggle's does: the server cannot
  // know the stored theme, and guessing paints the wrong radio for a frame.
  useEffect(() => {
    setTheme(readStoredTheme())
  }, [])

  const choose = (next: Theme) => {
    applyTheme(next)
    setTheme(next)
  }

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
      <InlineError>{error}</InlineError>

      {!fixtureMode && workspaceId === null && (
        <p className={styles.lockedNote}>These arrive once your calendar is set up.</p>
      )}

      <div className={styles.field}>
        <div className={styles.fieldHead}>
          <span className={styles.fieldLabel} id="settings-theme-label">
            Theme
          </span>
          <span className={styles.scopeTag}>This device</span>
        </div>
        <div className={styles.choices} role="radiogroup" aria-labelledby="settings-theme-label">
          {(['dark', 'light'] as const).map((option) => (
            <label key={option} className={styles.themeChoice}>
              <input
                type="radio"
                name="theme"
                value={option}
                checked={theme === option}
                // Until mount, neither is checked — honest, and gone within a frame.
                disabled={theme === null}
                onChange={() => choose(option)}
              />
              {option === 'dark' ? 'Dark (default)' : 'Light'}
            </label>
          ))}
        </div>
        <p className={styles.fieldNote}>
          Saved in this browser. Each of your devices keeps its own choice.
        </p>
      </div>

      <div className={styles.field}>
        {/* "Default view", not the old "Opens on". The feature was built, shipped and
            invisible: nobody looking for it searches a page for "opens". */}
        <label className={styles.fieldLabel} htmlFor="settings-default-view">
          Default view
        </label>
        <select
          id="settings-default-view"
          className={styles.select}
          value={defaultView}
          disabled={disabled}
          onChange={(event) =>
            void save({ defaultView: event.target.value as CalendarView })
          }
        >
          {/* The shared ordering and the shared labels: this select is where a view
              name gets CHOSEN, and every validator that later accepts it reads the same
              array. Four independent copies of this list is how a select comes to offer
              a value a parser rejects. */}
          {CALENDAR_VIEWS.map((value) => (
            <option key={value} value={value}>
              {VIEW_LABELS[value]}
            </option>
          ))}
        </select>
        <p className={styles.fieldNote}>
          The view your calendar opens on. You can also set this from the calendar itself.
        </p>
      </div>

      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="settings-keyboard">
          Keyboard shortcuts
        </label>
        {/* A select, not a bare checkbox: same control family as the rest of the page. Off
            is the default on purpose — single-key shortcuts are opt-in (WCAG 2.1.4), and
            speech-input users trigger them with ordinary dictation.

            The option labels are now plainly "Off" and "On". The on-label used to read
            "On: t, arrows, j/k, 1-4, n, ?", which listed the keys and none of their
            meanings — everything a reader needed to make the decision was missing from the
            one place the decision is made. The list below says what they do instead. */}
        <select
          id="settings-keyboard"
          className={styles.select}
          value={keyboardShortcuts ? 'on' : 'off'}
          disabled={disabled}
          onChange={(event) => void save({ keyboardShortcuts: event.target.value === 'on' })}
        >
          <option value="off">Off</option>
          <option value="on">On</option>
        </select>
        <p className={styles.fieldNote}>{HOTKEY_CAVEAT}</p>

        {/* Shown whichever way the switch is set: someone deciding to turn these ON needs
            to see what they are getting, and that is exactly when the setting is still off. */}
        <dl className={styles.keyList}>
          {HOTKEYS.map(([keys, action]) => (
            <div key={keys} className={styles.keyRow}>
              <dt className={styles.keyCombo}>
                <kbd>{keys}</kbd>
              </dt>
              <dd className={styles.keyAction}>{action}</dd>
            </div>
          ))}
        </dl>
      </div>
    </>
  )
}
