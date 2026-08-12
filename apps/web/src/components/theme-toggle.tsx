'use client'

import { useEffect, useState } from 'react'
import { applyTheme, readStoredTheme, type Theme } from '@/lib/theme'
import styles from './theme-toggle.module.css'

/**
 * Switch between light and dark.
 *
 * Subtle, and on every screen that has a header — the brief was "easy to find, not shouting".
 * So: an icon button in the header, low contrast until you hover or focus it, no label taking
 * up space, but a real accessible name and a title so it is discoverable by hover, by
 * keyboard and by screen reader.
 *
 * ---------------------------------------------------------------------------
 * WHY IT RENDERS NOTHING ON THE FIRST PASS
 * ---------------------------------------------------------------------------
 *
 * The stored preference lives in localStorage, which the server cannot read. If this rendered
 * a sun on the server and the visitor had chosen light, React would hydrate and swap it to a
 * moon — a hydration mismatch, and a visibly wrong icon for a frame.
 *
 * So the button appears after mount, once the real theme is known. The THEME itself does NOT
 * wait: `THEME_BOOTSTRAP` sets the attribute inline before first paint, so the page is already
 * the right colour. Only this one control is deferred, and it occupies its space either way so
 * nothing shifts.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null)

  useEffect(() => {
    setTheme(readStoredTheme())
  }, [])

  if (theme === null) {
    // Same size as the button, so the header does not reflow when it arrives.
    return <span className={styles.placeholder} aria-hidden="true" />
  }

  const next: Theme = theme === 'dark' ? 'light' : 'dark'

  return (
    <button
      type="button"
      className={styles.toggle}
      // Names the DESTINATION, not the current state. "Dark mode" as a label leaves a screen
      // reader user guessing whether it reports where they are or where they would go.
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      onClick={() => {
        applyTheme(next)
        setTheme(next)
      }}
    >
      {/* Shows the theme you would switch TO, which is the convention people already read
          without thinking about it. Both icons are inline paths — a font or a sprite for two
          glyphs is a network request the header does not need. */}
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">
        {next === 'light' ? (
          <>
            <circle cx="10" cy="10" r="4" fill="currentColor" />
            <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M10 1.5v2M10 16.5v2M1.5 10h2M16.5 10h2M4 4l1.4 1.4M14.6 14.6L16 16M16 4l-1.4 1.4M5.4 14.6L4 16" />
            </g>
          </>
        ) : (
          <path
            d="M16.5 12.4A7 7 0 0 1 7.6 3.5a7 7 0 1 0 8.9 8.9Z"
            fill="currentColor"
          />
        )}
      </svg>
    </button>
  )
}
