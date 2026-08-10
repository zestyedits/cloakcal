import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Temporal } from '@js-temporal/polyfill'
import {
  expandAllDay,
  expandSeries,
  resolveLocal,
  type SeriesSpec,
} from './recurrence.js'

/**
 * M1 gate — recurrence and DST.
 *
 * ADR 0001 is only worth having if something enforces it, and DST bugs are the kind that
 * appear twice a year on someone else's machine. These tests run across zones with
 * northern DST, southern DST (transitions reversed), half-hour DST, and no DST at all.
 *
 * Nothing here depends on the host machine's timezone. If any assertion could be changed
 * by running CI in Tokyo, it is a broken test.
 */

const ZONES = {
  newYork: 'America/New_York', // northern DST
  london: 'Europe/London', // northern DST, different transition dates
  sydney: 'Australia/Sydney', // southern DST — transitions reversed
  lordHowe: 'Australia/Lord_Howe', // 30-minute DST shift
  tokyo: 'Asia/Tokyo', // no DST, ever
  phoenix: 'America/Phoenix', // US, but no DST
  utc: 'UTC',
} as const

const ALL_ZONES = Object.values(ZONES)

/** 2026 transitions, checked against the tz database. */
const TRANSITIONS = {
  newYorkSpringForward: '2026-03-08', // 02:00 -> 03:00, gap 02:00-03:00
  newYorkFallBack: '2026-11-01', // 02:00 -> 01:00, 01:00-02:00 twice
  londonSpringForward: '2026-03-29', // 01:00 -> 02:00
  londonFallBack: '2026-10-25', // 02:00 -> 01:00
  sydneyFallBack: '2026-04-05', // southern autumn: 03:00 -> 02:00
  sydneySpringForward: '2026-10-04', // southern spring: 02:00 -> 03:00
} as const

const series = (over: Partial<SeriesSpec> = {}): SeriesSpec => ({
  dtstartLocal: '2026-01-06T09:00:00',
  durationMinutes: 60,
  timezone: ZONES.newYork,
  rrule: 'FREQ=WEEKLY;BYDAY=TU',
  ...over,
})

const wallClockOf = (iso: string) => iso.slice(11, 16)

/* -------------------------------------------------------------------------- */

describe('wall clock is preserved across DST transitions', () => {
  it('keeps a weekly 09:00 New York meeting at 09:00 through spring forward', () => {
    const occurrences = expandSeries(series(), {
      from: '2026-02-01T00:00:00Z',
      to: '2026-04-30T00:00:00Z',
    })

    expect(occurrences.length).toBeGreaterThan(8)
    for (const o of occurrences) {
      expect(wallClockOf(o.start)).toBe('09:00')
      expect(o.dst).toBe('none')
    }

    // The UTC instant must MOVE even though the wall clock does not — that is the whole
    // point. Before the transition 09:00 EST is 14:00Z; after, 09:00 EDT is 13:00Z.
    const before = occurrences.find((o) => o.occurrenceLocal < '2026-03-08')!
    const after = occurrences.find((o) => o.occurrenceLocal > '2026-03-08')!
    expect(before.startInstant.slice(11, 16)).toBe('14:00')
    expect(after.startInstant.slice(11, 16)).toBe('13:00')
  })

  it('keeps a weekly meeting at the same wall clock through fall back', () => {
    const occurrences = expandSeries(series(), {
      from: '2026-10-01T00:00:00Z',
      to: '2026-11-30T00:00:00Z',
    })
    for (const o of occurrences) expect(wallClockOf(o.start)).toBe('09:00')
  })

  it.each(ALL_ZONES)('preserves wall clock all year in %s', (timezone) => {
    const occurrences = expandSeries(series({ timezone, rrule: 'FREQ=WEEKLY;BYDAY=MO' }), {
      from: '2026-01-01T00:00:00Z',
      to: '2026-12-31T00:00:00Z',
    })
    expect(occurrences.length).toBeGreaterThan(45)
    for (const o of occurrences) expect(wallClockOf(o.start)).toBe('09:00')
  })

  it('handles monthly recurrence across both transitions', () => {
    const occurrences = expandSeries(
      series({ rrule: 'FREQ=MONTHLY;BYMONTHDAY=15', dtstartLocal: '2026-01-15T14:30:00' }),
      { from: '2026-01-01T00:00:00Z', to: '2026-12-31T00:00:00Z' },
    )
    expect(occurrences).toHaveLength(12)
    for (const o of occurrences) expect(wallClockOf(o.start)).toBe('14:30')
  })

  it('preserves wall clock in the southern hemisphere, where transitions run the other way', () => {
    const occurrences = expandSeries(
      series({ timezone: ZONES.sydney, dtstartLocal: '2026-03-02T08:00:00', rrule: 'FREQ=WEEKLY;BYDAY=MO' }),
      { from: '2026-03-01T00:00:00Z', to: '2026-11-01T00:00:00Z' },
    )
    for (const o of occurrences) expect(wallClockOf(o.start)).toBe('08:00')

    // Sydney's April transition moves the instant the opposite way to New York's March one.
    const march = occurrences.find((o) => o.occurrenceLocal.startsWith('2026-03-09'))!
    const may = occurrences.find((o) => o.occurrenceLocal.startsWith('2026-05-04'))!
    expect(march.start).toContain('+11:00') // AEDT
    expect(may.start).toContain('+10:00') // AEST
  })

  it('handles a 30-minute DST shift', () => {
    const occurrences = expandSeries(
      series({ timezone: ZONES.lordHowe, dtstartLocal: '2026-03-02T08:00:00', rrule: 'FREQ=WEEKLY;BYDAY=MO' }),
      { from: '2026-03-01T00:00:00Z', to: '2026-06-01T00:00:00Z' },
    )
    for (const o of occurrences) expect(wallClockOf(o.start)).toBe('08:00')
    expect(occurrences.some((o) => o.start.includes('+11:00'))).toBe(true)
    expect(occurrences.some((o) => o.start.includes('+10:30'))).toBe(true)
  })
})

describe('ambiguous local times take the earlier offset', () => {
  it('resolves 01:30 on New York fall-back day to the first pass', () => {
    const local = Temporal.PlainDateTime.from(`${TRANSITIONS.newYorkFallBack}T01:30:00`)
    const { zoned, dst } = resolveLocal(local, ZONES.newYork)

    expect(dst).toBe('ambiguous-earlier')
    expect(zoned.toString()).toContain('-04:00') // EDT, the first 01:30
    expect(zoned.toPlainDateTime().toString()).toBe(local.toString())
  })

  it('is genuinely the earlier of the two candidates', () => {
    const local = Temporal.PlainDateTime.from(`${TRANSITIONS.newYorkFallBack}T01:30:00`)
    const chosen = resolveLocal(local, ZONES.newYork).zoned.toInstant()
    const other = local.toZonedDateTime(ZONES.newYork, { disambiguation: 'later' }).toInstant()
    expect(Temporal.Instant.compare(chosen, other)).toBeLessThan(0)
  })

  it.each([
    [ZONES.newYork, TRANSITIONS.newYorkFallBack, '01:30'],
    [ZONES.london, TRANSITIONS.londonFallBack, '01:30'],
    [ZONES.sydney, TRANSITIONS.sydneyFallBack, '02:30'],
  ])('flags an ambiguous occurrence in %s', (timezone, date, time) => {
    const local = Temporal.PlainDateTime.from(`${date}T${time}:00`)
    const { dst, zoned } = resolveLocal(local, timezone)
    expect(dst).toBe('ambiguous-earlier')
    // Wall clock is preserved for ambiguity — only the offset differs.
    expect(zoned.toPlainDateTime().toString()).toBe(local.toString())
  })

  it('surfaces the flag through series expansion, so the UI can explain it', () => {
    const occurrences = expandSeries(
      series({ dtstartLocal: '2026-10-25T01:30:00', rrule: 'FREQ=WEEKLY;BYDAY=SU' }),
      { from: '2026-10-20T00:00:00Z', to: '2026-11-10T00:00:00Z' },
    )
    const onTransition = occurrences.find((o) =>
      o.occurrenceLocal.startsWith(TRANSITIONS.newYorkFallBack),
    )
    expect(onTransition?.dst).toBe('ambiguous-earlier')
  })
})

describe('nonexistent local times shift forward', () => {
  it('moves 02:30 to 03:30 on New York spring-forward day', () => {
    const local = Temporal.PlainDateTime.from(`${TRANSITIONS.newYorkSpringForward}T02:30:00`)
    const { zoned, dst } = resolveLocal(local, ZONES.newYork)

    expect(dst).toBe('nonexistent-shifted')
    // Shifted by the length of the gap, per ADR 0001 as amended — not to 03:00.
    expect(zoned.toPlainDateTime().toString()).toBe('2026-03-08T03:30:00')
    expect(zoned.toString()).toContain('-04:00')
  })

  it('never resolves backwards past the gap', () => {
    const local = Temporal.PlainDateTime.from(`${TRANSITIONS.newYorkSpringForward}T02:30:00`)
    const { zoned } = resolveLocal(local, ZONES.newYork)
    const earlier = local.toZonedDateTime(ZONES.newYork, { disambiguation: 'earlier' })
    expect(Temporal.Instant.compare(zoned.toInstant(), earlier.toInstant())).toBeGreaterThan(0)
  })

  it.each([
    [ZONES.newYork, TRANSITIONS.newYorkSpringForward, '02:30', '03:30'],
    [ZONES.london, TRANSITIONS.londonSpringForward, '01:30', '02:30'],
    [ZONES.sydney, TRANSITIONS.sydneySpringForward, '02:30', '03:30'],
  ])('shifts a gap time in %s', (timezone, date, time, expected) => {
    const local = Temporal.PlainDateTime.from(`${date}T${time}:00`)
    const { zoned, dst } = resolveLocal(local, timezone)
    expect(dst).toBe('nonexistent-shifted')
    expect(zoned.toPlainDateTime().toString().slice(11, 16)).toBe(expected)
  })

  it('keeps the exception key at the ORIGINAL local time, not the shifted one', () => {
    // If the key followed the shift, a cancellation recorded before the transition would
    // stop matching and the occurrence would silently reappear.
    const occurrences = expandSeries(
      series({ dtstartLocal: '2026-03-01T02:30:00', rrule: 'FREQ=WEEKLY;BYDAY=SU' }),
      { from: '2026-03-01T00:00:00Z', to: '2026-03-20T00:00:00Z' },
    )
    const shifted = occurrences.find((o) => o.dst === 'nonexistent-shifted')!
    expect(shifted.occurrenceLocal).toBe('2026-03-08T02:30:00')
    expect(shifted.start).toContain('03:30')
  })
})

describe('exceptions target the local occurrence key', () => {
  it('removes a cancelled occurrence', () => {
    const range = { from: '2026-01-01T00:00:00Z', to: '2026-02-28T00:00:00Z' }
    const all = expandSeries(series(), range)
    const withException = expandSeries(series(), range, [
      { occurrenceLocal: '2026-01-20T09:00:00', kind: 'cancelled' },
    ])

    expect(withException).toHaveLength(all.length - 1)
    expect(withException.map((o) => o.occurrenceLocal)).not.toContain('2026-01-20T09:00:00')
  })

  it('keeps a cancellation effective across a DST transition', () => {
    // The regression this guards: an instant-keyed exception stops matching after the
    // offset changes, and the cancelled meeting comes back from the dead.
    const spec = series({ dtstartLocal: '2026-03-01T09:00:00', rrule: 'FREQ=DAILY' })
    const cancelled = { occurrenceLocal: '2026-03-15T09:00:00', kind: 'cancelled' } as const

    const occurrences = expandSeries(
      spec,
      { from: '2026-03-01T00:00:00Z', to: '2026-03-31T00:00:00Z' },
      [cancelled],
    )
    expect(occurrences.map((o) => o.occurrenceLocal)).not.toContain('2026-03-15T09:00:00')
    expect(occurrences.some((o) => o.occurrenceLocal === '2026-03-14T09:00:00')).toBe(true)
    expect(occurrences.some((o) => o.occurrenceLocal === '2026-03-16T09:00:00')).toBe(true)
  })

  it('removes a moved occurrence from the series', () => {
    const range = { from: '2026-01-01T00:00:00Z', to: '2026-02-28T00:00:00Z' }
    const withMove = expandSeries(series(), range, [
      { occurrenceLocal: '2026-01-20T09:00:00', kind: 'moved' },
    ])
    expect(withMove.map((o) => o.occurrenceLocal)).not.toContain('2026-01-20T09:00:00')
  })

  it('ignores an exception that matches no occurrence', () => {
    const range = { from: '2026-01-01T00:00:00Z', to: '2026-02-28T00:00:00Z' }
    const all = expandSeries(series(), range)
    const withNoise = expandSeries(series(), range, [
      { occurrenceLocal: '2026-01-21T09:00:00', kind: 'cancelled' },
    ])
    expect(withNoise).toHaveLength(all.length)
  })
})

describe('all-day events stay date-only', () => {
  it('never resolves to an instant', () => {
    const occurrences = expandAllDay(
      { startDate: '2026-05-23', endDate: '2026-05-24', rrule: null },
      { from: '2026-05-01', to: '2026-05-31' },
    )
    expect(occurrences).toEqual([
      { occurrenceLocal: '2026-05-23', startDate: '2026-05-23', endDate: '2026-05-24' },
    ])
    // No 'T', no offset, no zone — the shape itself proves no instant was involved.
    for (const o of occurrences) {
      expect(o.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(o.endDate).not.toContain('T')
    }
  })

  it('lands on the same date regardless of any zone, because zones are not consulted', () => {
    // The classic bug: an all-day event stored as midnight drifts a day for eastern users.
    const occurrences = expandAllDay(
      { startDate: '2026-01-01', endDate: '2026-01-01', rrule: 'FREQ=YEARLY' },
      { from: '2026-01-01', to: '2028-12-31' },
    )
    expect(occurrences.map((o) => o.startDate)).toEqual(['2026-01-01', '2027-01-01', '2028-01-01'])
  })

  it('spans a multi-day range on every repeat', () => {
    const occurrences = expandAllDay(
      { startDate: '2026-05-04', endDate: '2026-05-06', rrule: 'FREQ=MONTHLY;COUNT=3' },
      { from: '2026-05-01', to: '2026-08-31' },
    )
    expect(occurrences).toHaveLength(3)
    for (const o of occurrences) {
      expect(Temporal.PlainDate.from(o.startDate).until(Temporal.PlainDate.from(o.endDate)).days).toBe(2)
    }
  })

  it('rejects an inverted range', () => {
    expect(() =>
      expandAllDay({ startDate: '2026-05-06', endDate: '2026-05-04', rrule: null }, {
        from: '2026-05-01',
        to: '2026-05-31',
      }),
    ).toThrow(/endDate must not be before startDate/)
  })
})

describe('properties', () => {
  it('preserves the wall clock for any zone, hour and weekday', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_ZONES),
        fc.integer({ min: 0, max: 23 }),
        fc.integer({ min: 0, max: 59 }),
        fc.constantFrom('MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'),
        (timezone, hour, minute, byday) => {
          const hh = String(hour).padStart(2, '0')
          const mm = String(minute).padStart(2, '0')
          const occurrences = expandSeries(
            {
              dtstartLocal: `2026-01-05T${hh}:${mm}:00`,
              durationMinutes: 30,
              timezone,
              rrule: `FREQ=WEEKLY;BYDAY=${byday}`,
            },
            { from: '2026-01-01T00:00:00Z', to: '2026-12-31T00:00:00Z' },
          )

          for (const o of occurrences) {
            // The only occurrences allowed to differ are ones we explicitly flagged.
            if (o.dst === 'none' || o.dst === 'ambiguous-earlier') {
              expect(wallClockOf(o.start)).toBe(`${hh}:${mm}`)
            } else {
              expect(o.dst).toBe('nonexistent-shifted')
            }
          }
        },
      ),
      { numRuns: 120 },
    )
  })

  it('never emits an occurrence outside the requested range', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_ZONES),
        fc.integer({ min: 1, max: 300 }),
        (timezone, days) => {
          const from = '2026-03-01T00:00:00Z'
          const to = Temporal.Instant.from(from).add({ hours: days * 24 }).toString()
          const occurrences = expandSeries(
            { dtstartLocal: '2026-01-01T09:00:00', durationMinutes: 60, timezone, rrule: 'FREQ=DAILY' },
            { from, to },
          )
          for (const o of occurrences) {
            expect(Temporal.Instant.compare(Temporal.Instant.from(o.startInstant), Temporal.Instant.from(from))).toBeGreaterThanOrEqual(0)
            expect(Temporal.Instant.compare(Temporal.Instant.from(o.startInstant), Temporal.Instant.from(to))).toBeLessThan(0)
          }
        },
      ),
      { numRuns: 60 },
    )
  })

  it('emits strictly increasing, unique occurrence keys', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_ZONES), (timezone) => {
        const occurrences = expandSeries(
          { dtstartLocal: '2026-01-01T09:00:00', durationMinutes: 60, timezone, rrule: 'FREQ=DAILY' },
          { from: '2026-01-01T00:00:00Z', to: '2026-12-31T00:00:00Z' },
        )
        const keys = occurrences.map((o) => o.occurrenceLocal)
        expect(new Set(keys).size).toBe(keys.length)
        expect([...keys].sort()).toEqual(keys)
      }),
      { numRuns: 20 },
    )
  })

  it('keeps duration exact across transitions', () => {
    const occurrences = expandSeries(series({ durationMinutes: 90 }), {
      from: '2026-01-01T00:00:00Z',
      to: '2026-12-31T00:00:00Z',
    })
    for (const o of occurrences) {
      const minutes = Temporal.Instant.from(o.startInstant)
        .until(Temporal.ZonedDateTime.from(o.end).toInstant())
        .total({ unit: 'minutes' })
      expect(minutes).toBe(90)
    }
  })
})

describe('input validation', () => {
  it('rejects a negative duration', () => {
    expect(() =>
      expandSeries(series({ durationMinutes: -1 }), {
        from: '2026-01-01T00:00:00Z',
        to: '2026-02-01T00:00:00Z',
      }),
    ).toThrow(/durationMinutes/)
  })

  it('rejects an inverted range', () => {
    expect(() =>
      expandSeries(series(), { from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }),
    ).toThrow(/range.from must not be after/)
  })

  it('expands a single non-recurring event exactly once', () => {
    const occurrences = expandSeries(series({ rrule: null }), {
      from: '2026-01-01T00:00:00Z',
      to: '2026-12-31T00:00:00Z',
    })
    expect(occurrences).toHaveLength(1)
    expect(occurrences[0]!.occurrenceLocal).toBe('2026-01-06T09:00:00')
  })
})
