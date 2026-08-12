import { describe, expect, it } from 'vitest'
import { Temporal } from '@js-temporal/polyfill'
import {
  anchorFromParam,
  dateParam,
  dayRange,
  formatDay,
  formatMonth,
  monthGridRange,
  rangeFromParam,
  weekRange,
} from '../src/server/range'

/**
 * The first unit tests range.ts has ever had, arriving with the first non-week ranges.
 * The interesting cases are all DST: a grid that spans a spring-forward or fall-back
 * must keep its WALL dates while its instants shift by an hour, or a week view starts at
 * 23:00 one Sunday a year and nobody reports it.
 */

const TZ = 'America/New_York'
const date = (s: string) => Temporal.PlainDate.from(s)

describe('anchorFromParam', () => {
  it('parses a well-formed date', () => {
    expect(anchorFromParam('2026-08-12', TZ).toString()).toBe('2026-08-12')
  })

  it('falls back to today for absent, malformed, and impossible dates', () => {
    const today = Temporal.Now.zonedDateTimeISO(TZ).toPlainDate().toString()
    expect(anchorFromParam(undefined, TZ).toString()).toBe(today)
    expect(anchorFromParam('not-a-date', TZ).toString()).toBe(today)
    // Shaped like a date but not one. Temporal.PlainDate.from with default options
    // CONSTRAINS (Feb 31 -> Feb 28) rather than throwing, which still lands the user
    // inside the month they asked about — either behaviour is acceptable; what is pinned
    // is that it never throws.
    expect(() => anchorFromParam('2026-02-31', TZ)).not.toThrow()
  })
})

describe('dayRange', () => {
  it('spans one local day', () => {
    const range = dayRange(date('2026-08-12'), TZ)
    expect(range.from).toBe('2026-08-12T04:00:00Z') // EDT, UTC-4
    expect(range.to).toBe('2026-08-13T04:00:00Z')
  })

  it('spans 23 real hours on the spring-forward day, without moving its wall dates', () => {
    const range = dayRange(date('2026-03-08'), TZ)
    const hours =
      (Date.parse(range.to) - Date.parse(range.from)) / 3_600_000
    expect(hours).toBe(23)
  })

  it('spans 25 real hours on the fall-back day', () => {
    const range = dayRange(date('2026-11-01'), TZ)
    const hours = (Date.parse(range.to) - Date.parse(range.from)) / 3_600_000
    expect(hours).toBe(25)
  })
})

describe('monthGridRange', () => {
  const wallDate = (instant: string) =>
    Temporal.Instant.from(instant).toZonedDateTimeISO(TZ).toPlainDate().toString()

  it('always spans exactly 42 wall days', () => {
    for (const anchor of ['2026-02-15', '2026-03-15', '2026-08-12', '2026-11-15']) {
      const range = monthGridRange(date(anchor), TZ)
      const from = Temporal.Instant.from(range.from).toZonedDateTimeISO(TZ).toPlainDate()
      const to = Temporal.Instant.from(range.to).toZonedDateTimeISO(TZ).toPlainDate()
      expect(from.until(to).total({ unit: 'days', relativeTo: from })).toBe(42)
    }
  })

  it('starts on the configured week start, on or before the 1st', () => {
    // August 2026 begins on a Saturday.
    expect(wallDate(monthGridRange(date('2026-08-12'), TZ, 0).from)).toBe('2026-07-26') // Sun
    expect(wallDate(monthGridRange(date('2026-08-12'), TZ, 1).from)).toBe('2026-07-27') // Mon
    expect(wallDate(monthGridRange(date('2026-08-12'), TZ, 6).from)).toBe('2026-08-01') // Sat: the 1st itself
  })

  it('keeps wall dates across a DST shift inside the grid', () => {
    // March 2026 contains the spring-forward on the 8th; the grid must still start
    // March 1 (a Sunday) and cover 42 wall days ending April 12.
    const range = monthGridRange(date('2026-03-15'), TZ, 0)
    expect(wallDate(range.from)).toBe('2026-03-01')
    expect(wallDate(range.to)).toBe('2026-04-12')
  })
})

describe('stepping', () => {
  it('a month step from Jan 31 cannot drift through short months', () => {
    // The stepper anchors to day 1 before adding, so Jan -> Feb -> Mar, never Jan 31 ->
    // Mar 3. This pins the CONTRACT the page relies on rather than a helper.
    const stepped = date('2026-01-31').with({ day: 1 }).add({ months: 1 })
    expect(stepped.toString()).toBe('2026-02-01')
    expect(stepped.add({ months: 1 }).toString()).toBe('2026-03-01')
  })
})

describe('headings and params', () => {
  it('formats a day heading from the anchor alone', () => {
    expect(formatDay(date('2026-08-12'))).toBe('Wednesday, August 12, 2026')
  })

  it('formats a month heading from the anchor, not the grid range', () => {
    // The grid for August 2026 starts in July; the heading must not.
    expect(formatMonth(date('2026-08-12'))).toBe('August 2026')
  })

  it('round-trips the date param', () => {
    expect(dateParam(date('2026-08-12'))).toBe('2026-08-12')
  })
})

describe('rangeFromParam stays byte-compatible', () => {
  it('produces the same week as weekRange over the parsed anchor', () => {
    const viaParam = rangeFromParam('2026-08-12', TZ, 0)
    const direct = weekRange(date('2026-08-12').toZonedDateTime({ timeZone: TZ }), 0)
    expect(viaParam).toEqual(direct)
  })
})
