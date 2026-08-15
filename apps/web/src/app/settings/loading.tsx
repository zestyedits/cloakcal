import Link from 'next/link'
import { CloakHomeLink } from '@/components/cloak-logo'
import { ThemeToggle } from '@/components/theme-toggle'
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
          {['Appearance', 'Time & region', 'Calendars', 'People & sharing', 'Security'].map(
            (label) => (
              <span key={label} className={settingsStyles.navLink}>
                {label}
              </span>
            ),
          )}
        </nav>

        <div className={settingsStyles.sections} aria-busy="true" aria-label="Loading settings">
          {Array.from({ length: 5 }, (_, i) => (
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
