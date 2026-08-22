'use client'

import Link from 'next/link'
import type { Route } from 'next'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

import { ThemeToggle } from './theme-toggle'
import { NavPendingMark } from './ui/nav-pending'
import styles from './page-shell.module.css'

/**
 * The bar that survives a move between the register and a contact's file.
 *
 * Same argument as `settings/settings-chrome.tsx`: only a shared LAYOUT stays mounted across
 * a sibling navigation, so a bar rendered by each page is a bar that is rebuilt on each
 * page. Here the pair is /people and /people/[contactId], and the register is the way up
 * from a file — going straight back to the calendar would skip the level the user came
 * through.
 */
export function PeopleChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const atRegister = pathname === '/people'
  const back: { href: Route; label: string } = atRegister
    ? { href: '/' as Route, label: 'Calendar' }
    : { href: '/people' as Route, label: 'People' }

  return (
    <div className={styles.shell}>
      <header className={styles.topBar}>
        <Link className={styles.back} href={back.href}>
          ‹ {back.label}
          <NavPendingMark />
        </Link>
        <div className={styles.spacer} />
        <ThemeToggle />
      </header>
      {children}
    </div>
  )
}
