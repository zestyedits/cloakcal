import { PageMasthead, PageShell } from '@/components/page-shell'
import { SettingsNav } from '@/components/settings/settings-nav'
import settingsStyles from '@/components/settings/settings.module.css'
import styles from '../loading.module.css'

/**
 * Its own fallback, not the inherited /settings one, for the reason the security and plan
 * fallbacks state: without this file Next uses the parent segment's loading state, which
 * says "Settings" and draws the rail's section chips, so opening Availability would flash a
 * different page's chrome and then swap.
 */
export default function AvailabilityLoading() {
  return (
    <PageShell back={{ href: '/settings', label: 'Settings' }}>
      <PageMasthead
        title="Availability"
        lede="The hours you are open, and what the calendar shades outside them."
      />

      <div className={settingsStyles.layout}>
        <SettingsNav current="availability" scope="settings" />

        <div className={settingsStyles.sections} aria-busy="true" aria-label="Loading availability">
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className={`${styles.sectionRow} ${styles.pulse}`} aria-hidden="true">
              <div className={styles.rowTitle} />
              <div className={styles.rowState} />
            </div>
          ))}
        </div>
      </div>
    </PageShell>
  )
}
