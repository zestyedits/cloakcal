'use client'

import Link from 'next/link'
import type { Route } from 'next'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

import { ThemeToggle } from '../theme-toggle'
import { NavPendingMark } from '../ui/nav-pending'
import styles from '../page-shell.module.css'

/**
 * The bar that does NOT remount when you move between settings pages.
 *
 * ---------------------------------------------------------------------------
 * WHY A LAYOUT AND NOT A COMPONENT EACH PAGE RENDERS
 * ---------------------------------------------------------------------------
 *
 * Every settings screen used to render its own `PageShell`, which meant the bar was a
 * different React element on every route: unmounted, remounted, repainted, and — with a
 * route-level `loading.tsx` in the way — briefly replaced by a drawn copy of itself. Four
 * pages, four identical bars, one of them always in the process of being rebuilt.
 *
 * Next only preserves what a shared LAYOUT owns. Moving the bar into `settings/layout.tsx`
 * makes it the same element across every sibling navigation, so it does not flash, does not
 * re-run its effects, and cannot drift from the copy a fallback used to draw, because there
 * is no longer a copy.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BACK TARGET IS COMPUTED HERE RATHER THAN PASSED IN
 * ---------------------------------------------------------------------------
 *
 * A layout cannot take a prop from the page beneath it, and that is the point: a prop would
 * be a value the page owns, which is exactly the coupling that made the bar remount. The hub
 * goes up to the calendar and every sub-page goes up to the hub — one rule, readable in one
 * place, and `usePathname` re-renders the LABEL without disturbing the element.
 *
 * ---------------------------------------------------------------------------
 * NO WORDMARK
 * ---------------------------------------------------------------------------
 *
 * `PageShell` centred a CloakCal lockup in this bar on every interior screen. A wordmark on
 * a settings sub-page tells the user nothing they do not already know and costs ~110px of a
 * 390px row — the same argument `cloak-logo.tsx` already makes for hiding it in the calendar
 * header. The brand belongs on the landing page and the auth screens, where somebody might
 * genuinely not know whose product this is.
 */
export function SettingsChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const atHub = pathname === '/settings'
  const back: { href: Route; label: string } = atHub
    ? { href: '/' as Route, label: 'Calendar' }
    : { href: '/settings' as Route, label: 'Settings' }

  return (
    <div className={styles.shell}>
      <header className={styles.topBar}>
        <Link className={styles.back} href={back.href}>
          ‹ {back.label}
          {/* The tapped control acknowledges itself while the route is in flight. This is
              the whole of the pending story now that no fallback paints: see ui/nav-pending. */}
          <NavPendingMark />
        </Link>
        <div className={styles.spacer} />
        <ThemeToggle />
      </header>
      {children}
    </div>
  )
}
