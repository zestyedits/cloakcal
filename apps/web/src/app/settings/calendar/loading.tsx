import { PageMasthead, PageShell } from '@/components/page-shell'
import settingsStyles from '@/components/settings/settings.module.css'
import styles from '../loading.module.css'

/** Its own fallback, not the inherited hub one. See /settings/privacy for why. */
export default function CalendarSettingsLoading() {
  return (
    <PageShell back={{ href: '/settings', label: 'Settings' }} measure="narrow">
      <PageMasthead
        title="Calendar"
        lede="Your calendars, the time they are drawn in, how they look, and the hours you are open."
      />

      <div className={settingsStyles.sections} aria-busy="true" aria-label="Loading calendar settings">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className={`${styles.sectionRow} ${styles.pulse}`} aria-hidden="true">
            <div className={styles.rowTitle} />
            <div className={styles.rowState} />
          </div>
        ))}
      </div>
    </PageShell>
  )
}
