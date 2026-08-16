import { PageMasthead, PageShell } from '@/components/page-shell'
import { SettingsNav } from '@/components/settings/settings-nav'
import settingsStyles from '@/components/settings/settings.module.css'
import styles from '../loading.module.css'

/**
 * Its own fallback, not the inherited /settings one, for the reason the security fallback
 * states: without this file Next uses the parent segment's loading state, which says
 * "Settings", points back at the calendar and draws the rail's section chips, so opening
 * Plan would flash a different page's chrome and then swap.
 */
export default function PlanLoading() {
  return (
    <PageShell back={{ href: '/settings', label: 'Settings' }}>
      <PageMasthead
        title="Plan"
        lede="What your account includes today, and what Pro will cost when billing opens."
      />

      {/* The REAL rail, from the one component that draws it. Copying its markup here is
          how the old settings fallback drifted to a rail the page no longer had. */}
      <div className={settingsStyles.layout}>
        <SettingsNav current="plan" scope="settings" />

        <div className={settingsStyles.sections} aria-busy="true" aria-label="Loading plan">
          {Array.from({ length: 3 }, (_, i) => (
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
