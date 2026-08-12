'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import styles from './mini-month.module.css'

/**
 * The sidebar's mini month — the board's `May 2025` grid with today in a filled disc.
 *
 * Every date is a real `<Link>` to `/?week=<that date>`: `rangeFromParam` resolves any
 * date to its week, so navigation stays server-side and redaction stays on the server,
 * exactly like the ‹ › steppers. No client state, no second range implementation.
 *
 * All the arithmetic here is WALL-DATE math on `YYYY-MM-DD` strings via `Date.UTC` — a
 * fixed instant read back with getUTC*, which cannot drift with the host timezone. The
 * only zone-aware step is formatting `page.from` and `now` INTO the display zone, done
 * with the same Intl pattern the week grid uses. Nothing here touches `dtstart_local`.
 */

const DAY_MS = 86_400_000

const toUtc = (day: string): number => {
  const [y, m, d] = day.split('-').map(Number)
  return Date.UTC(y!, m! - 1, d!)
}

const toDay = (utc: number): string => new Date(utc).toISOString().slice(0, 10)

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const

const DAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const

export function MiniMonth({
  from,
  anchorDate,
  timezone,
  weekStart,
  audience,
  view = 'agenda',
}: {
  /** ISO instant of the visible range's first day. */
  from: string
  /**
   * YYYY-MM-DD the page is anchored on. Preferred over `from` for deciding which month
   * to draw: a month view's RANGE starts in the previous month's grid margin, and a mini
   * month that says April over a page that says May is wrong in the way users notice.
   */
  anchorDate?: string | undefined
  timezone: string
  weekStart: number
  /** Carried into every link so View As survives navigation, like the steppers. */
  audience: string
  /**
   * The current view; links preserve it. Clicking a date on the day view opens that day,
   * on the month view that month — the mini month navigates, it never changes what kind
   * of thing you are looking at.
   */
  view?: 'agenda' | 'week' | 'day' | 'month'
}) {
  const { title, cells, names } = useMemo(() => {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    const weekFirst = fmt.format(new Date(from))
    const today = fmt.format(new Date())
    const weekDays = new Set(
      Array.from({ length: 7 }, (_, i) => toDay(toUtc(weekFirst) + i * DAY_MS)),
    )

    const [year, month] = (anchorDate ?? weekFirst).split('-').map(Number)
    const monthStart = Date.UTC(year!, month! - 1, 1)
    // Back up from the 1st to the configured week start, then six rows always — a fixed
    // height keeps the sidebar from jumping as the user steps across month boundaries.
    const startDow = new Date(monthStart).getUTCDay()
    const gridStart = monthStart - ((startDow - weekStart + 7) % 7) * DAY_MS

    const cells = Array.from({ length: 42 }, (_, i) => {
      const day = toDay(gridStart + i * DAY_MS)
      return {
        day,
        number: Number(day.slice(8, 10)),
        outside: Number(day.slice(5, 7)) !== month,
        today: day === today,
        inWeek: weekDays.has(day),
      }
    })

    const names = Array.from(
      { length: 7 },
      (_, i) => DAY_INITIALS[(weekStart + i) % 7]!,
    )

    return { title: `${MONTHS[month! - 1]} ${year}`, cells, names }
  }, [from, anchorDate, timezone, weekStart])

  const queryFor = (day: string): Record<string, string> => ({
    date: day,
    ...(view !== 'agenda' ? { view } : {}),
    ...(audience === 'owner' ? {} : { as: audience }),
  })

  const unit = view === 'day' ? 'day' : view === 'month' ? 'month' : 'week'

  return (
    <nav className={styles.root} aria-label={`Jump to a ${unit}`}>
      <h2 className={styles.title}>{title}</h2>
      <div className={styles.grid}>
        {names.map((name, i) => (
          <span key={`${name}-${i}`} className={styles.dayName} aria-hidden="true">
            {name}
          </span>
        ))}
        {cells.map((cell) => (
          <Link
            key={cell.day}
            className={styles.day}
            href={{ pathname: '/', query: queryFor(cell.day) }}
            data-outside={cell.outside || undefined}
            data-today={cell.today || undefined}
            data-in-week={cell.inWeek || undefined}
            aria-label={unit === 'week' ? `Week of ${cell.day}` : `Open ${cell.day}`}
            aria-current={cell.today ? 'date' : undefined}
          >
            <span className={styles.disc}>{cell.number}</span>
          </Link>
        ))}
      </div>
    </nav>
  )
}
