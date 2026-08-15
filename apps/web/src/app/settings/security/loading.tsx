import Link from 'next/link'
import { CloakHomeLink } from '@/components/cloak-logo'
import { ThemeToggle } from '@/components/theme-toggle'
import settingsStyles from '@/components/settings/settings.module.css'
import styles from '../loading.module.css'

/**
 * Its own fallback, not the inherited /settings one.
 *
 * Without this file Next would use the parent segment's loading state, which wears the
 * word "Settings", a back link to the calendar and a rail of five section chips — so
 * opening Security would flash a different page's chrome and then swap. That is the exact
 * freeze-then-teleport the settings fallback was written to stop; inheriting it here would
 * have reintroduced the problem while looking like reuse.
 *
 * Real chrome, from the real stylesheet. Only the panels shimmer.
 */
export default function SecurityLoading() {
  return (
    <div className={settingsStyles.page}>
      <header className={settingsStyles.header}>
        <Link className={settingsStyles.back} href="/settings">
          ‹ Settings
        </Link>
        <div className={settingsStyles.headerSpace} />
        <CloakHomeLink size="sm" />
        <div className={settingsStyles.headerSpace} />
        <ThemeToggle />
      </header>

      <div className={settingsStyles.narrowBody}>
        <h1 className={settingsStyles.title}>Security</h1>
        <p className={settingsStyles.pageLede}>
          Your password and your recovery phrase both open the same key. Changing either
          one re-wraps that key; neither one touches an event.
        </p>

        <div
          className={settingsStyles.sections}
          aria-busy="true"
          aria-label="Loading security settings"
        >
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className={`${styles.sectionRow} ${styles.pulse}`} aria-hidden="true">
              <div className={styles.rowTitle} />
              <div className={styles.rowState} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
