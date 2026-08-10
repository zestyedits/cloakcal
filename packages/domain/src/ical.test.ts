import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Temporal } from '@js-temporal/polyfill'
import { divergentOccurrences, fromIcalSeries, toIcalSeries } from './ical.js'
import { planSeriesEdit } from './edit-scope.js'
import { expandSeries, type SeriesSpec } from './recurrence.js'

/**
 * Import/export compatibility at the iCalendar boundary.
 *
 * Two things are being proven here:
 *   1. The inclusive UNTIL survives conversion to UTC and back, in every zone, including
 *      across DST transitions. Getting this wrong silently deletes the last occurrence of
 *      every truncated series.
 *   2. CloakCal's deliberate divergence from RFC 5545 §3.3.10 is bounded, detectable and
 *      reportable — not an accident waiting to be discovered by a user whose meeting
 *      failed to appear on the other side of a sync.
 */

const ZONES = [
  'America/New_York',
  'Europe/London',
  'Australia/Sydney',
  'Australia/Lord_Howe',
  'Asia/Tokyo',
  'UTC',
]

const series = (over: Partial<SeriesSpec> = {}): SeriesSpec => ({
  dtstartLocal: '2026-01-06T09:00:00',
  durationMinutes: 60,
  timezone: 'America/New_York',
  rrule: 'FREQ=WEEKLY;BYDAY=TU',
  ...over,
})

describe('DTSTART carries a TZID and local wall time', () => {
  it('exports local fields, never a UTC instant', () => {
    const ical = toIcalSeries(series())
    expect(ical.dtstart).toBe('DTSTART;TZID=America/New_York:20260106T090000')
    // No trailing Z: a zoned DTSTART must not be expressed as UTC, or the wall-clock
    // anchor is lost and the series stops being wall-clock preserving.
    expect(ical.dtstart).not.toMatch(/Z$/)
  })

  it.each(ZONES)('round-trips DTSTART in %s', (timezone) => {
    const spec = series({ timezone })
    const back = fromIcalSeries(toIcalSeries(spec), spec.durationMinutes)
    expect(back.dtstartLocal).toBe(spec.dtstartLocal)
    expect(back.timezone).toBe(timezone)
  })
})

describe('UNTIL converts to UTC on export', () => {
  it('turns the internal floating UNTIL into a real instant', () => {
    // 2026-03-10 08:59:59 in New York is EDT (-04:00) => 12:59:59Z
    const spec = series({ rrule: 'FREQ=WEEKLY;BYDAY=TU;UNTIL=20260310T085959Z' })
    expect(toIcalSeries(spec).rrule).toBe('RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20260310T125959Z')
  })

  it('uses the offset in force on that date, not a fixed one', () => {
    // Same wall clock, opposite side of the transition: EST (-05:00) => 13:59:59Z.
    const winter = series({ rrule: 'FREQ=WEEKLY;BYDAY=TU;UNTIL=20260203T085959Z' })
    expect(toIcalSeries(winter).rrule).toContain('UNTIL=20260203T135959Z')
  })

  it.each(ZONES)('round-trips UNTIL in %s', (timezone) => {
    const spec = series({ timezone, rrule: 'FREQ=WEEKLY;BYDAY=TU;UNTIL=20260310T085959Z' })
    const back = fromIcalSeries(toIcalSeries(spec), spec.durationMinutes)
    expect(back.rrule).toBe(spec.rrule)
  })

  it('leaves a rule without UNTIL untouched apart from the prefix', () => {
    expect(toIcalSeries(series()).rrule).toBe('RRULE:FREQ=WEEKLY;BYDAY=TU')
  })

  it('accepts a floating UNTIL on import and normalises it', () => {
    const back = fromIcalSeries(
      {
        dtstart: 'DTSTART;TZID=America/New_York:20260106T090000',
        rrule: 'RRULE:FREQ=WEEKLY;UNTIL=20260310T085959',
        timezone: 'America/New_York',
      },
      60,
    )
    expect(back.rrule).toContain('UNTIL=20260310T085959Z')
  })

  it('rejects a malformed date-time rather than guessing', () => {
    expect(() =>
      fromIcalSeries(
        { dtstart: 'DTSTART;TZID=UTC:not-a-date', rrule: null, timezone: 'UTC' },
        60,
      ),
    ).toThrow(/Malformed DTSTART/)
  })
})

describe('the inclusive UNTIL keeps the last occurrence', () => {
  it('does not drop the final occurrence of a truncated series', () => {
    // The failure this guards: UNTIL is inclusive, so a conversion that lands even one
    // second early silently removes the last meeting of every split series.
    const spec = series()
    const original = expandSeries(spec, { from: '2026-01-01T00:00:00Z', to: '2026-06-30T00:00:00Z' })
    const splitAt = original[8]!.occurrenceLocal

    const plan = planSeriesEdit({ series: spec, occurrenceLocal: splitAt, scope: 'this-and-future' })
    const truncated = { ...spec, rrule: plan.truncateSeriesTo }

    const before = expandSeries(truncated, { from: '2026-01-01T00:00:00Z', to: '2026-06-30T00:00:00Z' })
    const roundTripped = expandSeries(
      fromIcalSeries(toIcalSeries(truncated), spec.durationMinutes),
      { from: '2026-01-01T00:00:00Z', to: '2026-06-30T00:00:00Z' },
    )

    expect(roundTripped.map((o) => o.occurrenceLocal)).toEqual(before.map((o) => o.occurrenceLocal))
    expect(before.at(-1)!.occurrenceLocal).toBe(original[7]!.occurrenceLocal)
  })

  it('survives a truncation boundary that lands on a DST transition day', () => {
    for (const [timezone, dtstart] of [
      ['America/New_York', '2026-03-01T09:00:00'],
      ['America/New_York', '2026-10-25T09:00:00'],
      ['Australia/Sydney', '2026-03-29T09:00:00'],
      ['Europe/London', '2026-03-22T09:00:00'],
    ] as const) {
      const spec = series({ timezone, dtstartLocal: dtstart, rrule: 'FREQ=DAILY' })
      const range = { from: '2026-01-01T00:00:00Z', to: '2026-12-31T00:00:00Z' }
      const original = expandSeries(spec, range)

      for (const target of original.slice(0, 12)) {
        const plan = planSeriesEdit({
          series: spec,
          occurrenceLocal: target.occurrenceLocal,
          scope: 'this-and-future',
        })
        const truncated = { ...spec, rrule: plan.truncateSeriesTo }
        const direct = expandSeries(truncated, range).map((o) => o.occurrenceLocal)
        const viaIcal = expandSeries(
          fromIcalSeries(toIcalSeries(truncated), spec.durationMinutes),
          range,
        ).map((o) => o.occurrenceLocal)

        expect(viaIcal).toEqual(direct)
      }
    }
  })

  it('round-trips losslessly for arbitrary split points and zones', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ZONES),
        fc.integer({ min: 1, max: 15 }),
        fc.constantFrom('FREQ=DAILY', 'FREQ=WEEKLY;BYDAY=TU', 'FREQ=MONTHLY;BYMONTHDAY=15'),
        (timezone, index, rrule) => {
          const spec = series({ timezone, rrule })
          const range = { from: '2026-01-01T00:00:00Z', to: '2026-12-31T00:00:00Z' }
          const original = expandSeries(spec, range)
          if (index >= original.length) return

          const plan = planSeriesEdit({
            series: spec,
            occurrenceLocal: original[index]!.occurrenceLocal,
            scope: 'this-and-future',
          })
          const truncated = { ...spec, rrule: plan.truncateSeriesTo }

          expect(
            expandSeries(fromIcalSeries(toIcalSeries(truncated), 60), range).map(
              (o) => o.occurrenceLocal,
            ),
          ).toEqual(expandSeries(truncated, range).map((o) => o.occurrenceLocal))
        },
      ),
      { numRuns: 120 },
    )
  })
})

describe('divergence from RFC 5545 §3.3.10 is bounded and reportable', () => {
  const gapSeries = series({ dtstartLocal: '2026-03-01T02:30:00', rrule: 'FREQ=WEEKLY;BYDAY=SU' })
  const range = { from: '2026-02-01T00:00:00Z', to: '2026-04-30T00:00:00Z' }

  it('keeps an instance a strict implementation would drop', () => {
    // §3.3.10: a generated instance whose local time does not exist "MUST be ignored".
    // CloakCal shifts it instead (ADR 0001), applying §3.3.5's DATE-TIME rule.
    const occurrences = expandSeries(gapSeries, range)
    const shifted = occurrences.filter((o) => o.dst === 'nonexistent-shifted')

    expect(shifted).toHaveLength(1)
    expect(shifted[0]!.occurrenceLocal).toBe('2026-03-08T02:30:00')
    expect(shifted[0]!.start).toContain('03:30')
  })

  it('reports exactly which occurrences a recipient will be missing', () => {
    const divergent = divergentOccurrences(expandSeries(gapSeries, range))
    expect(divergent).toEqual(['2026-03-08T02:30:00'])
  })

  it('reports nothing for a series that never touches a gap', () => {
    expect(divergentOccurrences(expandSeries(series(), range))).toEqual([])
  })

  it('reports nothing in a zone with no DST at all', () => {
    const tokyo = series({ ...gapSeries, timezone: 'Asia/Tokyo' })
    expect(divergentOccurrences(expandSeries(tokyo, range))).toEqual([])
  })

  it('bounds the divergence to at most one instance per transition', () => {
    // The seam must be small and predictable. A daily 02:30 series crosses exactly one
    // spring-forward gap per year, so exactly one instance can diverge.
    const daily = series({ dtstartLocal: '2026-01-01T02:30:00', rrule: 'FREQ=DAILY' })
    const divergent = divergentOccurrences(
      expandSeries(daily, { from: '2026-01-01T00:00:00Z', to: '2026-12-31T00:00:00Z' }),
    )
    expect(divergent).toHaveLength(1)
    expect(divergent[0]).toBe('2026-03-08T02:30:00')
  })

  it('does not treat ambiguous fall-back times as divergent, because those follow the RFC', () => {
    // §3.3.5 specifies the earlier occurrence, which is what we do — no seam here.
    const fallBack = series({ dtstartLocal: '2026-10-25T01:30:00', rrule: 'FREQ=WEEKLY;BYDAY=SU' })
    const occurrences = expandSeries(fallBack, {
      from: '2026-10-01T00:00:00Z',
      to: '2026-11-30T00:00:00Z',
    })
    expect(occurrences.some((o) => o.dst === 'ambiguous-earlier')).toBe(true)
    expect(divergentOccurrences(occurrences)).toEqual([])
  })
})

describe('exported UNTIL is a valid UTC instant', () => {
  it.each(ZONES)('parses as an instant in %s', (timezone) => {
    const spec = series({ timezone, rrule: 'FREQ=DAILY;UNTIL=20260610T235959Z' })
    const until = /UNTIL=(\d{8}T\d{6}Z)/.exec(toIcalSeries(spec).rrule!)![1]!
    const iso = `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}T${until.slice(9, 11)}:${until.slice(11, 13)}:${until.slice(13, 15)}Z`
    expect(() => Temporal.Instant.from(iso)).not.toThrow()
  })
})
