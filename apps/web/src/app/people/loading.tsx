import { PageShell } from '@/components/page-shell'
import peopleStyles from '@/components/people-screen.module.css'
import styles from './loading.module.css'

/**
 * Loading state for /people and /people/[contactId], following the settings-loading
 * lesson: the chrome is the REAL chrome (same stylesheet, same header), so the navigation
 * reads as "People, loading its rows" rather than a freeze and a teleport. The body is
 * text-free shapes — this fallback serves both the list and a contact's file, and any
 * words here would be wrong for one of them.
 */
export default function PeopleLoading() {
  return (
    <PageShell back={{ href: '/', label: 'Calendar' }} measure="narrow">
      <main className={peopleStyles.main} aria-busy="true" aria-label="Loading people">
        <div className={`${styles.titleBar} ${styles.pulse}`} />
        <div className={`${styles.ledeBar} ${styles.pulse}`} />
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className={`${styles.row} ${styles.pulse}`}>
            <div className={styles.name} />
            <div className={styles.action} />
          </div>
        ))}
      </main>
    </PageShell>
  )
}
