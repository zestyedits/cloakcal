'use client'

import { useMemo } from 'react'
import styles from './week-strip.module.css'

/**
 * The board's mobile week strip: `S M T W T F S` over dates, today in a filled disc.
 *
 * Each day is an IN-PAGE anchor to that day's agenda group (`#day-YYYY-MM-DD`) — the
 * events are already on the page, one fetch, already redacted, so jumping to Thursday
 * must not be a server round trip. Days with no events still render as targets; the jump
 * simply lands at the nearest content, which beats a strip whose tappability varies by
 * how busy the week was.
 */

const DAY_MS = 86_400_000
const DAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const

export function WeekStrip({ from, timezone }: { from: string; timezone: string }) {
  const days = useMemo(() => {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    const today = fmt.format(new Date())
    const first = new Date(from).getTime()

    return Array.from({ length: 7 }, (_, i) => {
      const day = fmt.format(new Date(first + i * DAY_MS))
      const dow = new Date(`${day}T00:00:00Z`).getUTCDay()
      return {
        day,
        name: DAY_INITIALS[dow]!,
        number: Number(day.slice(8, 10)),
        today: day === today,
      }
    })
  }, [from, timezone])

  return (
    <nav className={styles.root} aria-label="Jump to a day">
      {days.map((entry) => (
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
      ))}
    </nav>
  )
}
