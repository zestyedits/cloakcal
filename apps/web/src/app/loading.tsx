import { CloakHomeLink, CloakMark } from '@/components/cloak-logo'
import { ThemeToggle } from '@/components/theme-toggle'
import cal from '@/components/calendar-screen.module.css'
import styles from './loading.module.css'

/**
 * Route-level loading state for `/` — the calendar's WHOLE shell, not an agenda skeleton.
 *
 * The first version was a bare column of grey rows, and it followed the path settings
 * discovered the hard way: arriving from /people or /settings swapped the entire screen
 * for a third, alien page — a freeze, then a teleport. So this is the settings-loading
 * lesson applied to the calendar: the chrome is the REAL chrome (same stylesheet, same
 * header, same sidebar and bottom-nav geometry), and the only things that shimmer are
 * the shapes whose contents genuinely are not known yet. The lockup and theme toggle
 * are live; everything else inert until the data lands.
 *
 * Words here are CHROME words only (view names, Cloak) — static strings the leak scans
 * never have to reason about, exactly like the settings fallback's section labels. The
 * date range, event rows and calendar names stay shapes: those are data.
 *
 * Note that in-app steppers and view switches never show this at all: a same-segment
 * searchParams navigation does not re-trigger a loading boundary (measured, 0/7 runs),
 * and their acknowledgment is ui/nav-pending.tsx instead. This fallback serves hard
 * loads and cross-segment arrivals. One honest trade-off: `/` is also the signed-out
 * landing page, so a first-time visitor sees one beat of app frame before the landing
 * streams in. The frame is quiet, brief, and shows nothing false; branching on the
 * session here is impossible because a loading file renders before the server has
 * decided anything.
 */
export default function Loading() {
  return (
    <div className={cal.shell}>
      <header className={cal.header}>
        <CloakHomeLink size="sm" />

        <div className={`${cal.placeCluster} ${styles.inert}`} aria-hidden="true">
          <span className={cal.weekNav}>
            <span className={cal.weekStep}>‹</span>
            <span className={`${styles.rangeBar} ${styles.pulse}`} />
            <span className={cal.weekStep}>›</span>
          </span>
          <span className={cal.today}>
            <span className={`${styles.todayShape} ${styles.pulse}`} />
          </span>
        </div>

        <div className={cal.headerEnd}>
          <div className={`${cal.headerViews} ${styles.inert}`} aria-hidden="true">
            <span className={cal.viewSwitch}>
              <span className={cal.viewSegment}>Agenda</span>
              <span className={cal.viewSegment}>Week</span>
              <span className={cal.viewSegment}>Day</span>
              <span className={cal.viewSegment}>Month</span>
            </span>
            <span className={cal.controlDivider} />
            <span className={cal.cloakHeaderButton}>
              <CloakMark size={16} />
              Cloak
            </span>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <aside className={`${cal.sidebar} ${styles.inert}`} aria-hidden="true">
        <span className={cal.sidebarCompose}>
          <span className={`${styles.blockShape} ${styles.pulse}`} />
        </span>
        <span className={cal.sidebarMonth}>
          <span className={`${styles.monthShape} ${styles.pulse}`} />
        </span>
        <span className={`${styles.viewAsShape} ${styles.pulse}`} />
      </aside>

      {/* `aria-busy` on a quiet region — screen readers get the one useful fact
          (loading) once, instead of a live region narrating shimmer. */}
      <main id="main" className={cal.main} aria-busy="true" aria-label="Loading your calendar">
        <div className={styles.inner}>
          <div className={`${styles.bar} ${styles.pulse}`} />
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className={`${styles.row} ${styles.pulse}`}>
              <div className={styles.time} />
              <div className={styles.line} />
              <div className={styles.chip} />
            </div>
          ))}
        </div>
      </main>

      <nav className={`${cal.nav} ${styles.inert}`} aria-hidden="true">
        <span className={cal.navItem}>Day</span>
        <span className={cal.navItem}>Week</span>
        <span className={cal.cloakTile}>
          <CloakMark size={18} />
          Cloak
        </span>
        <span className={cal.navItem}>Agenda</span>
        <span className={cal.navItem}>Month</span>
      </nav>
    </div>
  )
}
