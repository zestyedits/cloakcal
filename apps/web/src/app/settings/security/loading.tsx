import { PageMasthead, PageShell } from '@/components/page-shell'
import settingsStyles from '@/components/settings/settings.module.css'
import styles from '../loading.module.css'

/**
 * Its own fallback, not the inherited /settings one.
 *
 * Without this file Next would use the parent segment's loading state, which says
 * "Settings", points back at the calendar and draws four doors — so opening this page would
 * flash a different page's chrome and then swap. That is the exact freeze-then-teleport the
 * settings fallbacks were written to stop; inheriting one here would have reintroduced the
 * problem while looking like reuse.
 *
 * The title matches the page in lockstep. It said "Security" while the page said "Security &
 * data" for the length of one edit, which is a title that changes as the content arrives.
 */
export default function SecurityLoading() {
  return (
    <PageShell back={{ href: '/settings', label: 'Settings' }} measure="narrow">
      <PageMasthead
        title="Security &amp; data"
        lede="Your password, your passkeys and your recovery phrase all open the same key. Changing any one of them re-wraps that key; none of them touches an event."
      />

      <div
        className={settingsStyles.sections}
        aria-busy="true"
        aria-label="Loading security settings"
      >
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
