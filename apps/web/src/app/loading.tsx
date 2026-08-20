import { CloakHomeLink, CloakMark } from '@/components/cloak-logo'
import { SettingsMark } from '@/components/settings-mark'
import { ThemeToggle } from '@/components/theme-toggle'
import { HEADER_VIEWS, NAV_LEADING, NAV_TRAILING, VIEW_LABELS } from '@/lib/calendar-views'
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
        {/* `compact`, exactly as the real header does. Without it this drew the wordmark on a
            phone where the destination draws the mark alone -- a ~110px width jump in the
            header at the moment of handoff, in the one place the flag exists to prevent. */}
        <CloakHomeLink size="sm" compact />

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
              {HEADER_VIEWS.map((view) => (
                <span key={view} className={cal.viewSegment}>
                  {VIEW_LABELS[view]}
                </span>
              ))}
            </span>
            <span className={cal.controlDivider} />
            <span className={cal.cloakHeaderButton}>
              <CloakMark size={16} />
              Cloak
            </span>
          </div>
          {/*
            THE PHONE'S TOP-RIGHT SLOT, matching the destination rather than the shell this
            file was written against.

            It used to draw a bare <ThemeToggle /> and no Settings control. On a phone the
            real header is the other way round: `.headerSettings` is visible below 900px and
            `.headerTheme` is hidden below it. So the fallback showed a control the
            destination does not have and omitted the one it does, and both changed at
            handoff. Same wrappers and same classes now, so the two cannot drift by editing
            one of them.

            A span rather than the real Link: nothing here should look pressable before the
            page it belongs to is, which is the rule the settings fallback already follows.
          */}
          <span className={cal.headerSettings}>
            <SettingsMark />
          </span>
          <span className={cal.headerTheme}>
            <ThemeToggle />
          </span>
        </div>
      </header>

      <aside className={`${cal.sidebar} ${styles.inert}`} aria-hidden="true">
        <span className={cal.sidebarCompose}>
          <span className={`${styles.blockShape} ${styles.pulse}`} />
        </span>
        <span className={cal.sidebarMonth}>
          <span className={`${styles.monthShape} ${styles.pulse}`} />
        </span>
        {/* Two footprints, each held at the width that actually renders it. The phone's
            audience row is 44px plus an 8px margin; the 6rem card it used to stand in for is
            what the DESKTOP still draws. One unconditional shape could only be wrong on one
            of them, and it was wrong by 68px on the surface with the least room. */}
        <span className={`${styles.audienceShape} ${styles.pulse}`} />
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
        {NAV_LEADING.map((view) => (
          <span key={view} className={cal.navItem}>
            {VIEW_LABELS[view]}
          </span>
        ))}
        <span className={cal.cloakTile}>
          <CloakMark size={18} />
          Cloak
        </span>
        {NAV_TRAILING.map((view) => (
          <span key={view} className={cal.navItem}>
            {VIEW_LABELS[view]}
          </span>
        ))}
      </nav>
    </div>
  )
}
