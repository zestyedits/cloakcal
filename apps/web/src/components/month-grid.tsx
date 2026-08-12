'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import type { RedactedOccurrence } from '@/server/audience'
import { CloakedText } from './cloaked-text'
import styles from './month-grid.module.css'

/**
 * Month view: 7 × 6 cells over the grid range the server fetched (always 42 days — see
 * monthGridRange). Each cell is one <Link> into that day's day view; the entries inside
 * are display-only spans — editing and visibility live in agenda/day, where there is room
 * for the controls. Up to three entries per cell (all-day first), then "+N more".
 *
 * STILL DISPLAY-ONLY AFTER THE 2026-08 GRID-INTERACTIONS PASS, decided rather than
 * deferred by neglect: an interactive entry inside the cell <Link> is
 * interactive-inside-interactive — invalid HTML whether the entry is an <a> or a
 * <button> — so the "cheap" version does not exist; the real one restructures the cell
 * (date number becomes the drill link) and reworks the month specs, for a view whose own
 * density warning above says there is no room for controls. Week and day blocks are the
 * doors now, one click away. grid-interactions.spec.ts pins that this view has no edit
 * buttons, so revisiting this is a decision, not a drift.
 *
 * NO PRIVACY CHIP AT THIS DENSITY, DELIBERATELY. The chip inks are verified against
 * composited washes that do not exist in an 84-cell grid, and the tokens forbid colour as
 * the sole carrier of meaning — a bare coloured dot standing for "limited" would be
 * exactly that defect. Month density carries WHEN and WHICH CALENDAR; the privacy level
 * is one click away in the day view. (Redacted "Busy" entries still show the engine
 * working.)
 *
 * All date arithmetic is the mini month's wall-date technique: format instants INTO the
 * display zone once, then pure Date.UTC stepping on the resulting YYYY-MM-DD strings.
 * Nothing here touches dtstart_local.
 */

const DAY_MS = 86_400_000
const DAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const
const MAX_ENTRIES = 3

export function MonthGrid({
  occurrences,
  from,
  timezone,
  anchorDate,
  audience,
  colorFor,
}: {
  occurrences: readonly RedactedOccurrence[]
  /** ISO instant of the grid's first day. */
  from: string
  timezone: string
  /** YYYY-MM-DD the view is anchored on — its month decides which cells are "outside". */
  anchorDate: string
  /** Carried into every day link so View As survives the drill-down. */
  audience: string
  colorFor: (calendarId: string | undefined) => string
}) {
  const { cells, names } = useMemo(() => {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    const first = fmt.format(new Date(from))
    const today = fmt.format(new Date())
    const month = anchorDate.slice(5, 7)
    const start = Date.UTC(
      Number(first.slice(0, 4)),
      Number(first.slice(5, 7)) - 1,
      Number(first.slice(8, 10)),
    )

    const byDay = new Map<string, RedactedOccurrence[]>()
    for (const occurrence of occurrences) {
      const day = occurrence.start.includes('T')
        ? occurrence.occurrenceLocal.slice(0, 10)
        : occurrence.start
      const bucket = byDay.get(day)
      if (bucket === undefined) byDay.set(day, [occurrence])
      else bucket.push(occurrence)
    }
    // All-day entries first within each cell, then by start time — the same priority a
    // paper calendar gives them.
    for (const bucket of byDay.values()) {
      bucket.sort((a, b) =>
        Number(b.allDay ?? false) - Number(a.allDay ?? false) || a.start.localeCompare(b.start),
      )
    }

    const startDow = new Date(start).getUTCDay()
    const cells = Array.from({ length: 42 }, (_, i) => {
      const day = new Date(start + i * DAY_MS).toISOString().slice(0, 10)
      return {
        day,
        number: Number(day.slice(8, 10)),
        outside: day.slice(5, 7) !== month,
        today: day === today,
        entries: byDay.get(day) ?? [],
      }
    })

    const names = Array.from({ length: 7 }, (_, i) => DAY_INITIALS[(startDow + i) % 7]!)
    return { cells, names }
  }, [occurrences, from, timezone, anchorDate])

  const queryFor = (day: string): Record<string, string> =>
    audience === 'owner'
      ? { view: 'day', date: day }
      : { view: 'day', date: day, as: audience }

  return (
    <div className={styles.grid}>
      {names.map((name, i) => (
        <span key={`${name}-${i}`} className={styles.dayName} aria-hidden="true">
          {name}
        </span>
      ))}
      {cells.map((cell) => (
        <Link
          key={cell.day}
          className={styles.cell}
          href={{ pathname: '/', query: queryFor(cell.day) }}
          data-outside={cell.outside || undefined}
          data-today={cell.today || undefined}
          aria-label={`Open ${cell.day}${cell.entries.length > 0 ? `, ${cell.entries.length} ${cell.entries.length === 1 ? 'event' : 'events'}` : ''}`}
          aria-current={cell.today ? 'date' : undefined}
        >
          <span className={styles.number}>{cell.number}</span>
          {cell.entries.slice(0, MAX_ENTRIES).map((occurrence) => (
            <span
              key={`${occurrence.eventId}:${occurrence.occurrenceLocal}`}
              className={styles.entry}
              data-color={colorFor(occurrence.calendarId)}
            >
              <span className={styles.spine} aria-hidden="true" />
              <span className={styles.entryTitle}>
                {occurrence.time === 'busy' ? (
                  'Busy'
                ) : (
                  <CloakedText
                    subjectType="event"
                    subjectId={occurrence.eventId}
                    fieldName="title"
                    placeholder="Private event"
                  />
                )}
              </span>
            </span>
          ))}
          {cell.entries.length > MAX_ENTRIES && (
            <span className={styles.more}>+{cell.entries.length - MAX_ENTRIES} more</span>
          )}
        </Link>
      ))}
    </div>
  )
}
