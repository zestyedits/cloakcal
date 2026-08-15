import Link from 'next/link'
import { CloakHomeLink } from '@/components/cloak-logo'
import { ThemeToggle } from '@/components/theme-toggle'
import { SECTIONS } from '@/lib/settings-sections'
import settingsStyles from '@/components/settings/settings.module.css'
import styles from './loading.module.css'

/**
 * The settings page's loading state — and deliberately AS MUCH of the real page as can
 * exist without data. The first version was all grey bars, which read as a third, alien
 * page between the calendar and settings: a freeze, then a teleport. The chrome here is
 * the REAL chrome (same stylesheet, same header, same title, same nav chips), so the
 * navigation reads as "settings, loading its rows" — the only things that shimmer are
 * the section cards whose contents genuinely aren't known yet.
 *
 * The nav chips are real anchor links: they cannot open a card that has not arrived, but
 * the hash survives into the loaded page, whose deep-link effect opens the right card.
 */
export default function SettingsLoading() {
  return (
    <div className={settingsStyles.page}>
      <header className={settingsStyles.header}>
        <Link className={settingsStyles.back} href="/">
          ‹ Calendar
        </Link>
        <div className={settingsStyles.headerSpace} />
        <CloakHomeLink size="sm" />
        <div className={settingsStyles.headerSpace} />
        <ThemeToggle />
      </header>

      <div className={settingsStyles.body}>
        <h1 className={settingsStyles.title}>Settings</h1>

        <nav className={settingsStyles.nav} aria-label="Settings sections">
          {/* The REAL list, not a second copy of it. Both were hand-edited when the page
              went from seven cards to five, which is one edit away from the fallback
              flashing a rail the loaded page does not have. It comes from lib/, not from
              the screen: this file is a SERVER component, and importing a plain value out
              of a 'use client' module hands back a reference proxy rather than the value. */}
          {SECTIONS.map((section) => (
            <span key={section.id} className={settingsStyles.navLink}>
              {section.label}
            </span>
          ))}
        </nav>

        <div className={settingsStyles.sections} aria-busy="true" aria-label="Loading settings">
          {Array.from({ length: SECTIONS.length }, (_, i) => (
            <div key={i} className={`${styles.sectionRow} ${styles.pulse}`}>
              <div className={styles.rowTitle} />
              <div className={styles.rowState} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
