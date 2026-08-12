'use client'

import { useEffect, useState } from 'react'
import { applyTheme, readStoredTheme, type Theme } from '@/lib/theme'
import styles from './settings.module.css'

/**
 * Theme choice as labelled radio cards — the header toggle's logic, in a form that reads
 * as a setting. No DB behind it: the preference is per-browser (localStorage), and the
 * copy says so instead of implying it follows the account.
 *
 * State defers to mount for the same reason the toggle does: the server cannot know the
 * stored theme, and guessing paints the wrong radio for a frame.
 */
export function AppearanceSection() {
  const [theme, setTheme] = useState<Theme | null>(null)

  useEffect(() => {
    setTheme(readStoredTheme())
  }, [])

  const choose = (next: Theme) => {
    applyTheme(next)
    setTheme(next)
  }

  return (
    <>
      <p className={styles.sectionLede}>
        Saved in this browser. Each of your devices keeps its own choice.
      </p>

      <div className={styles.controls} role="radiogroup" aria-label="Theme">
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
    </>
  )
}
