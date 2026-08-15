import { PageMasthead, PageShell } from '@/components/page-shell'
import { SECTIONS } from '@/lib/settings-sections'
import settingsStyles from '@/components/settings/settings.module.css'
import styles from './loading.module.css'

/**
 * The settings page's loading state — and deliberately AS MUCH of the real page as can
 * exist without data. The first version was all grey bars, which read as a third, alien
 * page between the calendar and settings: a freeze, then a teleport. The chrome here is
 * the REAL chrome, from the REAL components (PageShell, PageMasthead, the same section
 * list), so the navigation reads as "settings, loading its rows" and the only things that
 * shimmer are the cards whose contents genuinely are not known yet.
 *
 * The nav chips are inert spans: they cannot open a card that has not arrived. The hash
 * survives into the loaded page, whose deep-link effect opens the right card.
 */
export default function SettingsLoading() {
  return (
    <PageShell back={{ href: '/', label: 'Calendar' }}>
      <PageMasthead
        title="Settings"
        lede="How your calendar looks and behaves, who can see what, and how you get back in."
      />

      <div className={settingsStyles.layout}>
        <nav className={settingsStyles.nav} aria-label="Settings sections">
          {SECTIONS.map((section) => (
            <span key={section.id} className={settingsStyles.navLink}>
              {section.label}
            </span>
          ))}
        </nav>

        <div className={settingsStyles.sections} aria-busy="true" aria-label="Loading settings">
          {SECTIONS.map((section) => (
            <div
              key={section.id}
              className={`${styles.sectionRow} ${styles.pulse}`}
              aria-hidden="true"
            >
              <div className={styles.rowTitle} />
              <div className={styles.rowState} />
            </div>
          ))}
        </div>
      </div>
    </PageShell>
  )
}
