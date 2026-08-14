'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { NavPendingMark } from './ui/nav-pending'
import styles from './week-strip.module.css'

/**
 * The board's mobile week strip: `S M T W T F S` over dates, today in a filled disc.
 *
 * TWO MODES, because the data situation differs per view:
 *
 * - `anchors` (the agenda): each day is an IN-PAGE anchor to that day's agenda group
 *   (`#day-YYYY-MM-DD`) — the events are already on the page, one fetch, already
 *   redacted, so jumping to Thursday must not be a server round trip.
 * - `links` (the day view): the page holds ONE day, so the other six are genuinely not
 *   here. Each day becomes a server link to `/?view=day&date=…`, with the shown day
 *   marked current. The strip renders the anchor's whole week, computed with wall-date
 *   math from the configured week start.
 *
 * Days with no events still render as targets; a strip whose tappability varies by how
 * busy the week was would be worse than an occasional no-op jump.
 */

const DAY_MS = 86_400_000
const DAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const

const toUtc = (day: string): number => {
  const [y, m, d] = day.split('-').map(Number)
  return Date.UTC(y!, m! - 1, d!)
}

export function WeekStrip({
  from,
  timezone,
  mode = 'anchors',
  anchorDate,
  weekStart = 0,
  audience = 'owner',
}: {
  /** ISO instant of the page range's first day (anchors mode reads the week from it). */
  from: string
  timezone: string
  mode?: 'anchors' | 'links'
  /** links mode: the day being shown, YYYY-MM-DD. */
  anchorDate?: string | undefined
  weekStart?: number
  audience?: string
}) {
  const days = useMemo(() => {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    const today = fmt.format(new Date())

    // links mode walks the anchor's week as wall dates; anchors mode walks the page's
    // range the way the week grid does (instant stepping formatted into the zone).
    let dayList: string[]
    if (mode === 'links' && anchorDate !== undefined) {
      const anchorUtc = toUtc(anchorDate)
      const dow = new Date(anchorUtc).getUTCDay()
      const first = anchorUtc - ((dow - weekStart + 7) % 7) * DAY_MS
      dayList = Array.from({ length: 7 }, (_, i) =>
        new Date(first + i * DAY_MS).toISOString().slice(0, 10),
      )
    } else {
      const first = new Date(from).getTime()
      dayList = Array.from({ length: 7 }, (_, i) => fmt.format(new Date(first + i * DAY_MS)))
    }

    return dayList.map((day) => {
      const dow = new Date(`${day}T00:00:00Z`).getUTCDay()
      return {
        day,
        name: DAY_INITIALS[dow]!,
        number: Number(day.slice(8, 10)),
        today: day === today,
        current: mode === 'links' && day === anchorDate,
      }
    })
  }, [from, timezone, mode, anchorDate, weekStart])

  return (
    <nav className={styles.root} aria-label="Jump to a day">
      {days.map((entry) =>
        mode === 'links' ? (
          <Link
            key={entry.day}
            className={styles.day}
            href={{
              pathname: '/',
              query: {
                view: 'day',
                date: entry.day,
                ...(audience === 'owner' ? {} : { as: audience }),
              },
            }}
            data-today={entry.today || undefined}
            aria-current={entry.current ? 'page' : entry.today ? 'date' : undefined}
          >
            <span className={styles.name} aria-hidden="true">
              {entry.name}
            </span>
            <span className={styles.number}>{entry.number}</span>
            <NavPendingMark />
          </Link>
        ) : (
          <a
            key={entry.day}
            className={styles.day}
            href={`#day-${entry.day}`}
            data-today={entry.today || undefined}
            aria-current={entry.today ? 'date' : undefined}
          >
            <span className={styles.name} aria-hidden="true">
              {entry.name}
            </span>
            <span className={styles.number}>{entry.number}</span>
          </a>
        ),
      )}
    </nav>
  )
}
