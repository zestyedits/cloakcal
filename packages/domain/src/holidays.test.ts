import { describe, expect, it } from 'vitest'
import {
  HOLIDAY_REGIONS,
  easterSunday,
  holidaysByDate,
  holidaysForYear,
  holidaysInRange,
  isHolidayRegion,
  regionFromTimezone,
  type HolidayRegion,
} from './holidays.js'

/**
 * These tests pin dates against the real world, not against the implementation.
 *
 * Every expectation here was taken from the published calendar for that year rather than
 * from running the code and writing down what came out. That distinction is the whole value:
 * a holiday table that agrees with itself is worth nothing, and the failure mode of this
 * module is silent — a wrong nth-weekday shifts a day off by a week and looks completely
 * plausible on screen.
 */

/** Every holiday name on a given date, for a region. */
const on = (region: HolidayRegion, year: number, date: string): string[] =>
  holidaysForYear(region, year)
    .filter((h) => h.date === date)
    .map((h) => h.name)

/** The date a named holiday falls on. */
const dateOf = (region: HolidayRegion, year: number, name: string): string | undefined =>
  holidaysForYear(region, year).find((h) => h.name === name)?.date

describe('easterSunday', () => {
  // Published Gregorian Easter dates. The algorithm is transcribed arithmetic, so a slip in
  // any one line moves Good Friday, Easter Monday and Mothering Sunday together.
  it.each([
    [2024, '2024-03-31'],
    [2025, '2025-04-20'],
    [2026, '2026-04-05'],
    [2027, '2027-03-28'],
    [2028, '2028-04-16'],
    [2030, '2030-04-21'],
  ])('puts Easter %i on %s', (year, expected) => {
    expect(easterSunday(year).toString()).toBe(expected)
  })
})

describe('United States', () => {
  it('places the floating federal holidays in 2026', () => {
    expect(dateOf('US', 2026, 'Martin Luther King Jr. Day')).toBe('2026-01-19')
    expect(dateOf('US', 2026, "Presidents' Day")).toBe('2026-02-16')
    expect(dateOf('US', 2026, 'Memorial Day')).toBe('2026-05-25')
    expect(dateOf('US', 2026, 'Labor Day')).toBe('2026-09-07')
    expect(dateOf('US', 2026, 'Thanksgiving')).toBe('2026-11-26')
  })

  it('observes a Saturday holiday on the Friday before', () => {
    // 4 July 2026 is a Saturday, so the federal holiday is Friday the 3rd. Both are emitted:
    // one is when the thing is, the other is when the office is shut.
    expect(on('US', 2026, '2026-07-04')).toContain('Independence Day')
    expect(on('US', 2026, '2026-07-03')).toContain('Independence Day (observed)')
  })

  it('observes a Sunday holiday on the Monday after', () => {
    // 25 December 2022 was a Sunday.
    expect(on('US', 2022, '2022-12-26')).toContain('Christmas Day (observed)')
  })

  it("carries New Year's Day back into the previous December", () => {
    // 1 January 2022 was a Saturday, so the federal holiday was Friday 31 December 2021 —
    // a date in the previous year, which a naive per-year loop drops entirely.
    expect(on('US', 2022, '2021-12-31')).toContain("New Year's Day (observed)")
    expect(holidaysInRange('US', '2021-12-01', '2022-01-01').map((h) => h.date)).toContain(
      '2021-12-31',
    )
  })

  it('does not invent Juneteenth before it was a federal holiday', () => {
    expect(dateOf('US', 2020, 'Juneteenth')).toBeUndefined()
    expect(dateOf('US', 2021, 'Juneteenth')).toBe('2021-06-19')
  })

  it('marks observances as observances, not days off', () => {
    const halloween = holidaysForYear('US', 2026).find((h) => h.name === 'Halloween')
    expect(halloween?.kind).toBe('observance')
    expect(halloween?.date).toBe('2026-10-31')
    expect(holidaysForYear('US', 2026).find((h) => h.name === 'Thanksgiving')?.kind).toBe('public')
  })
})

describe('United Kingdom', () => {
  it('derives the Easter bank holidays', () => {
    expect(dateOf('GB', 2026, 'Good Friday')).toBe('2026-04-03')
    expect(dateOf('GB', 2026, 'Easter Monday')).toBe('2026-04-06')
  })

  it('places the three bank holiday Mondays in 2026', () => {
    expect(dateOf('GB', 2026, 'Early May Bank Holiday')).toBe('2026-05-04')
    expect(dateOf('GB', 2026, 'Spring Bank Holiday')).toBe('2026-05-25')
    expect(dateOf('GB', 2026, 'Summer Bank Holiday')).toBe('2026-08-31')
  })

  it('gives Christmas and Boxing Day different substitute days', () => {
    // 25 December 2027 is a Saturday and the 26th a Sunday. The substitutes are Monday the
    // 27th and Tuesday the 28th. This is the case that a naive "weekend rolls to Monday"
    // silently collapses into one holiday.
    const days = holidaysForYear('GB', 2027)
    expect(days.find((h) => h.name === 'Christmas Day (observed)')?.date).toBe('2027-12-27')
    expect(days.find((h) => h.name === 'Boxing Day (observed)')?.date).toBe('2027-12-28')
  })

  it('steps a substitute over a holiday that already owns the day', () => {
    // 25 December 2022 was a Sunday, and Boxing Day itself took Monday the 26th. Christmas
    // therefore moves to Tuesday the 27th, not onto the 26th.
    expect(holidaysForYear('GB', 2022).find((h) => h.name === 'Christmas Day (observed)')?.date).toBe(
      '2022-12-27',
    )
  })

  it('uses Mothering Sunday rather than the May date', () => {
    // Three weeks before Easter, so it moves with Easter and lands in March, not May.
    expect(dateOf('GB', 2026, "Mother's Day")).toBe('2026-03-15')
    expect(dateOf('US', 2026, "Mother's Day")).toBe('2026-05-10')
  })
})

describe('the other regions', () => {
  it('puts Victoria Day on the Monday on or before 24 May', () => {
    expect(dateOf('CA', 2026, 'Victoria Day')).toBe('2026-05-18')
    expect(dateOf('CA', 2027, 'Victoria Day')).toBe('2027-05-24')
  })

  it('keeps Anzac Day on its date in Australia', () => {
    expect(dateOf('AU', 2026, 'Anzac Day')).toBe('2026-04-25')
    expect(dateOf('AU', 2026, 'Australia Day')).toBe('2026-01-26')
  })

  it("moves St Brigid's Day to 1 February when that is a Friday", () => {
    // The statutory exception: normally the first Monday, but 1 February 2030 is a Friday.
    expect(dateOf('IE', 2030, "St Brigid's Day")).toBe('2030-02-01')
    expect(dateOf('IE', 2026, "St Brigid's Day")).toBe('2026-02-02')
    expect(dateOf('IE', 2022, "St Brigid's Day")).toBeUndefined()
  })

  it('reads Matariki from the statute table and omits it once the table ends', () => {
    expect(dateOf('NZ', 2026, 'Matariki')).toBe('2026-07-10')
    expect(dateOf('NZ', 2032, 'Matariki')).toBe('2032-07-02')
    // Deliberately absent rather than extrapolated — it follows a lunar rising, and a guessed
    // public holiday is wrong on a day people book around with nothing to say so.
    expect(dateOf('NZ', 2033, 'Matariki')).toBeUndefined()
  })

  it("Mondayises both of New Zealand's new year days without collision", () => {
    // 1 January 2022 was a Saturday and the 2nd a Sunday.
    const days = holidaysForYear('NZ', 2022)
    expect(days.find((h) => h.name === "New Year's Day (observed)")?.date).toBe('2022-01-03')
    expect(days.find((h) => h.name === "Day after New Year's Day (observed)")?.date).toBe(
      '2022-01-04',
    )
  })
})

describe('ranges', () => {
  it('is half-open, matching expandSeries', () => {
    const names = holidaysInRange('US', '2026-12-25', '2026-12-31').map((h) => h.name)
    expect(names).toContain('Christmas Day')
    expect(names).not.toContain("New Year's Eve")
    expect(holidaysInRange('US', '2026-12-31', '2027-01-01').map((h) => h.name)).toContain(
      "New Year's Eve",
    )
  })

  it('returns nothing for an inverted range rather than throwing', () => {
    expect(holidaysInRange('US', '2026-06-01', '2026-01-01')).toEqual([])
  })

  it('groups by date for the per-day views', () => {
    const map = holidaysByDate('GB', '2026-12-01', '2027-01-01')
    expect(map.get('2026-12-25')?.map((h) => h.name)).toEqual(['Christmas Day'])
    expect(map.get('2026-12-24')?.map((h) => h.name)).toEqual(['Christmas Eve'])
    expect(map.get('2026-12-03')).toBeUndefined()
  })

  it('sorts by date and never emits a date outside the window', () => {
    const found = holidaysInRange('NZ', '2026-01-01', '2027-01-01')
    expect(found.length).toBeGreaterThan(0)
    for (const holiday of found) {
      expect(holiday.date >= '2026-01-01').toBe(true)
      expect(holiday.date < '2027-01-01').toBe(true)
    }
    expect([...found].sort((a, b) => a.date.localeCompare(b.date))).toEqual(found)
  })
})

describe('regions', () => {
  it('guesses a region from a zone, and admits when it cannot', () => {
    expect(regionFromTimezone('America/New_York')).toBe('US')
    expect(regionFromTimezone('Europe/London')).toBe('GB')
    expect(regionFromTimezone('Europe/Dublin')).toBe('IE')
    expect(regionFromTimezone('Australia/Sydney')).toBe('AU')
    expect(regionFromTimezone('Pacific/Auckland')).toBe('NZ')
    // Canada shares the America/ prefix with the US, which is the wrong answer this function
    // is most likely to give.
    expect(regionFromTimezone('America/Toronto')).toBe('CA')
    expect(regionFromTimezone('America/Vancouver')).toBe('CA')
    // Null rather than a guess: the settings screen turns this into an explicit question.
    expect(regionFromTimezone('Europe/Berlin')).toBeNull()
    expect(regionFromTimezone('Asia/Tokyo')).toBeNull()
  })

  it('validates a stored region', () => {
    expect(isHolidayRegion('US')).toBe(true)
    expect(isHolidayRegion('us')).toBe(false)
    expect(isHolidayRegion('DE')).toBe(false)
    expect(isHolidayRegion(undefined)).toBe(false)
  })

  it('gives every declared region a non-empty table', () => {
    // Guards against a region being added to the picker with no holidays behind it, which
    // renders as a working setting that does nothing.
    for (const { id } of HOLIDAY_REGIONS) {
      const days = holidaysForYear(id, 2026)
      expect(days.filter((h) => h.kind === 'public').length).toBeGreaterThanOrEqual(8)
      expect(days.some((h) => h.kind === 'observance')).toBe(true)
    }
  })

  it('never emits a holiday whose region disagrees with the one asked for', () => {
    for (const { id } of HOLIDAY_REGIONS) {
      expect(holidaysForYear(id, 2026).every((h) => h.region === id)).toBe(true)
    }
  })
})
