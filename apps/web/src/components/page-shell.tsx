import Link from 'next/link'
import type { ReactNode } from 'react'
import type { Route } from 'next'
import { CloakHomeLink } from './cloak-logo'
import { ThemeToggle } from './theme-toggle'
import styles from './page-shell.module.css'

/**
 * The shell /settings, /settings/security and /people all wear.
 *
 * They had three different top bars carrying the same four things in three arrangements,
 * which is drift rather than variety and a fair part of why these pages read as thrown
 * together beside the calendar. One bar: the way back on the left, the lockup centred and
 * still the door home, the theme toggle on the right.
 *
 * NOT a client component. It renders links and one small client island (the toggle), so
 * keeping it on the server lets the loading fallbacks — which are server components — wear
 * the identical chrome from the identical source instead of copying it. That copying is
 * what let the settings fallback drift to a five-chip rail the real page no longer had.
 */
export function PageShell({
  back,
  measure = 'wide',
  children,
}: {
  /** Where "up" goes from here, and what to call it. */
  back: { href: Route; label: string }
  /**
   * How wide the content block is. `wide` suits a rail plus cards; `narrow` suits a single
   * column of forms or list rows, where 64rem would leave a third of the block empty and
   * the whole page reading as pushed to one side.
   */
  measure?: 'wide' | 'narrow'
  children: ReactNode
}) {
  return (
    <div className={styles.shell}>
      <header className={styles.topBar}>
        <Link className={styles.back} href={back.href}>
          ‹ {back.label}
        </Link>
        <div className={styles.spacer} />
        <CloakHomeLink size="sm" />
        <div className={styles.spacer} />
        <ThemeToggle />
      </header>
      <div className={`${styles.body} ${measure === 'narrow' ? styles.narrow : ''}`}>
        {children}
      </div>
    </div>
  )
}

/**
 * Title, one line on what the page is for, and an engraved rule beneath.
 *
 * The rule is the load-bearing part. Without it a title sits in open black above a column
 * of cards with nothing joining them, which is exactly the "no hierarchy" complaint: the
 * eye gets a big word, then a gap, then some strips, and has to infer the relationship.
 */
export function PageMasthead({ title, lede }: { title: string; lede: string }) {
  return (
    <div className={styles.masthead}>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.lede}>{lede}</p>
    </div>
  )
}

/**
 * The content block, without a bar.
 *
 * For routes whose chrome lives in a LAYOUT (settings today, people next). `PageShell`
 * still exists for the one-off pages that have no shared segment — legal, contact — where a
 * layout would own a bar for a single child and buy nothing.
 */
export function PageBody({
  measure = 'wide',
  children,
}: {
  measure?: 'wide' | 'narrow'
  children: ReactNode
}) {
  return (
    <div className={`${styles.body} ${measure === 'narrow' ? styles.narrow : ''}`}>{children}</div>
  )
}

export { styles as pageShellStyles }
