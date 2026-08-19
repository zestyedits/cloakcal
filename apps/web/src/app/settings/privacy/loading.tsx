import { PageMasthead, PageShell } from '@/components/page-shell'
import settingsStyles from '@/components/settings/settings.module.css'
import styles from '../loading.module.css'

/**
 * Its own fallback, not the inherited /settings one.
 *
 * Without this file Next uses the parent segment's loading state, which says "Settings",
 * points back at the calendar and draws four doors — so opening Privacy would flash a
 * different page's chrome and then swap. That is the exact freeze-then-teleport the settings
 * fallbacks exist to stop; inheriting one here would reintroduce it while looking like reuse.
 */
export default function PrivacyLoading() {
  return (
    <PageShell back={{ href: '/settings', label: 'Settings' }} measure="narrow">
      <PageMasthead
        title="Privacy"
        lede="What each person and group sees of your calendar, and who those people are."
      />

      <div className={settingsStyles.sections} aria-busy="true" aria-label="Loading privacy settings">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className={`${styles.sectionRow} ${styles.pulse}`} aria-hidden="true">
            <div className={styles.rowTitle} />
            <div className={styles.rowState} />
          </div>
        ))}
      </div>
    </PageShell>
  )
}
