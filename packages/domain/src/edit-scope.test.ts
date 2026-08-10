import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Temporal } from '@js-temporal/polyfill'
import { isValidRrule, planSeriesEdit, planOccurrenceDelete, truncateRrule } from './edit-scope.js'
import { expandSeries, type SeriesSpec } from './recurrence.js'

/**
 * M1 gate — the three recurrence edit scopes (spec §3).
 *
 * The headline test is `split preserves the occurrence set`: after a "this and future"
 * edit, expanding the truncated original plus the new series must reproduce exactly the
 * occurrences the original series would have produced — no gap at the seam, no duplicate.
 * Off-by-one at a series split is the classic bug here, and it is invisible until someone
 * notices a missing or doubled meeting.
 */

const ZONES = ['America/New_York', 'Europe/London', 'Australia/Sydney', 'Asia/Tokyo', 'UTC']

const series = (over: Partial<SeriesSpec> = {}): SeriesSpec => ({
  dtstartLocal: '2026-01-06T09:00:00',
  durationMinutes: 60,
  timezone: 'America/New_York',
  rrule: 'FREQ=WEEKLY;BYDAY=TU',
  ...over,
})

const RANGE = { from: '2026-01-01T00:00:00Z', to: '2026-06-30T00:00:00Z' }

describe('scope: this event', () => {
  const plan = planSeriesEdit({
    series: series(),
    occurrenceLocal: '2026-02-10T09:00:00',
    scope: 'this',
  })

  it('detaches exactly one occurrence and leaves the rule alone', () => {
    expect(plan.exceptions).toEqual([{ occurrenceLocal: '2026-02-10T09:00:00', kind: 'moved' }])
    expect(plan.truncateSeriesTo).toBeNull()
    expect(plan.newSeries).toBeNull()
    expect(plan.detachedOccurrence).toEqual({ occurrenceLocal: '2026-02-10T09:00:00' })
  })

  it('records it as moved rather than cancelled, so history reads correctly', () => {
    // "I edited that one" and "I deleted that one" must not look identical in the audit log.
    expect(plan.exceptions[0]!.kind).toBe('moved')
    expect(planOccurrenceDelete('2026-02-10T09:00:00').kind).toBe('cancelled')
  })

  it('removes only the edited occurrence from the series', () => {
    const before = expandSeries(series(), RANGE)
    const after = expandSeries(series(), RANGE, plan.exceptions)
    expect(after).toHaveLength(before.length - 1)
    expect(after.map((o) => o.occurrenceLocal)).not.toContain('2026-02-10T09:00:00')
  })

  it('explains the consequence in plain language', () => {
    expect(plan.summary).toMatch(/only this occurrence/i)
    expect(plan.summary).toMatch(/rest of the series/i)
  })
})

describe('scope: this and future', () => {
  const splitAt = '2026-03-10T09:00:00'
  const plan = planSeriesEdit({ series: series(), occurrenceLocal: splitAt, scope: 'this-and-future' })

  it('truncates the original and starts a new series at the split point', () => {
    expect(plan.truncateSeriesTo).toMatch(/UNTIL=20260310T085959Z/)
    expect(plan.newSeries?.dtstartLocal).toBe(splitAt)
    expect(plan.newSeries?.rrule).toBe('FREQ=WEEKLY;BYDAY=TU')
    expect(plan.exceptions).toEqual([])
  })

  it('carries the timezone and duration onto the new series', () => {
    expect(plan.newSeries?.timezone).toBe('America/New_York')
    expect(plan.newSeries?.durationMinutes).toBe(60)
  })

  it('splits the occurrence set with no gap and no duplicate', () => {
    const original = expandSeries(series(), RANGE).map((o) => o.occurrenceLocal)

    const truncated = expandSeries(series({ rrule: plan.truncateSeriesTo }), RANGE)
    const continued = expandSeries(plan.newSeries!, RANGE)
    const rejoined = [...truncated, ...continued].map((o) => o.occurrenceLocal)

    expect(rejoined).toEqual(original)
    expect(new Set(rejoined).size).toBe(rejoined.length)
  })

  it('puts the split occurrence in the NEW series, not the old one', () => {
    const truncated = expandSeries(series({ rrule: plan.truncateSeriesTo }), RANGE)
    const continued = expandSeries(plan.newSeries!, RANGE)

    expect(truncated.map((o) => o.occurrenceLocal)).not.toContain(splitAt)
    expect(continued.map((o) => o.occurrenceLocal)).toContain(splitAt)
  })

  it('leaves past occurrences with their original definition', () => {
    const truncated = expandSeries(series({ rrule: plan.truncateSeriesTo }), RANGE)
    expect(truncated.every((o) => o.occurrenceLocal < splitAt)).toBe(true)
  })

  it('explains that earlier occurrences are untouched', () => {
    expect(plan.summary).toMatch(/earlier occurrences stay/i)
  })
})

describe('scope: entire series', () => {
  const plan = planSeriesEdit({
    series: series(),
    occurrenceLocal: '2026-03-10T09:00:00',
    scope: 'entire-series',
  })

  it('makes no structural change', () => {
    expect(plan.exceptions).toEqual([])
    expect(plan.truncateSeriesTo).toBeNull()
    expect(plan.newSeries).toBeNull()
    expect(plan.detachedOccurrence).toBeNull()
  })

  it('warns that past occurrences change too', () => {
    // The consequence users most often fail to anticipate.
    expect(plan.summary).toMatch(/already happened/i)
  })
})

describe('single events have no scope to choose', () => {
  it.each(['this', 'this-and-future', 'entire-series'] as const)(
    'collapses %s to entire-series',
    (scope) => {
      const plan = planSeriesEdit({
        series: series({ rrule: null }),
        occurrenceLocal: '2026-01-06T09:00:00',
        scope,
      })
      expect(plan.scope).toBe('entire-series')
      expect(plan.summary).toBe('This event will be updated.')
    },
  )
})

describe('truncateRrule', () => {
  const at = Temporal.PlainDateTime.from('2026-03-10T08:59:59')

  it('appends UNTIL when absent', () => {
    expect(truncateRrule('FREQ=WEEKLY;BYDAY=TU', at)).toBe(
      'FREQ=WEEKLY;BYDAY=TU;UNTIL=20260310T085959Z',
    )
  })

  it('replaces an existing UNTIL rather than adding a second', () => {
    const out = truncateRrule('FREQ=WEEKLY;UNTIL=20261231T000000Z;BYDAY=TU', at)
    expect(out.match(/UNTIL=/g)).toHaveLength(1)
    expect(out).toContain('UNTIL=20260310T085959Z')
  })

  it('drops COUNT, which RFC 5545 forbids alongside UNTIL', () => {
    const out = truncateRrule('FREQ=WEEKLY;COUNT=10;BYDAY=TU', at)
    expect(out).not.toMatch(/COUNT=/i)
    expect(out).toContain('UNTIL=')
  })

  it('produces a rule rrule can actually parse', () => {
    expect(isValidRrule(truncateRrule('FREQ=WEEKLY;COUNT=10;BYDAY=TU', at))).toBe(true)
  })
})

describe('isValidRrule', () => {
  it.each([
    'FREQ=DAILY',
    'FREQ=WEEKLY;BYDAY=MO,WE,FR',
    'FREQ=MONTHLY;BYMONTHDAY=15',
    'FREQ=MONTHLY;BYDAY=2TU',
    'FREQ=YEARLY;BYMONTH=5;BYMONTHDAY=23',
    'FREQ=WEEKLY;INTERVAL=2;COUNT=10',
  ])('accepts %s', (rule) => {
    expect(isValidRrule(rule)).toBe(true)
  })

  it.each(['', 'BYDAY=MO', 'FREQ=NONSENSE', 'not a rule at all'])('rejects %s', (rule) => {
    expect(isValidRrule(rule)).toBe(false)
  })
})

describe('properties', () => {
  it('splits losslessly at any occurrence, in any zone', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ZONES),
        fc.integer({ min: 1, max: 20 }),
        fc.constantFrom('FREQ=DAILY', 'FREQ=WEEKLY;BYDAY=TU', 'FREQ=MONTHLY;BYMONTHDAY=15'),
        (timezone, index, rrule) => {
          const spec = series({ timezone, rrule, dtstartLocal: '2026-01-06T09:00:00' })
          const original = expandSeries(spec, RANGE)
          if (index >= original.length) return

          const splitAt = original[index]!.occurrenceLocal
          const plan = planSeriesEdit({ series: spec, occurrenceLocal: splitAt, scope: 'this-and-future' })

          const rejoined = [
            ...expandSeries({ ...spec, rrule: plan.truncateSeriesTo }, RANGE),
            ...expandSeries(plan.newSeries!, RANGE),
          ].map((o) => o.occurrenceLocal)

          expect(rejoined).toEqual(original.map((o) => o.occurrenceLocal))
        },
      ),
      { numRuns: 150 },
    )
  })

  it('splits losslessly across a DST transition', () => {
    // The seam is riskiest exactly where the offset changes, so pin it there explicitly
    // rather than hoping the random property run lands on it.
    for (const [timezone, dtstart, range] of [
      ['America/New_York', '2026-03-01T09:00:00', { from: '2026-03-01T00:00:00Z', to: '2026-03-31T00:00:00Z' }],
      ['America/New_York', '2026-10-25T09:00:00', { from: '2026-10-25T00:00:00Z', to: '2026-11-15T00:00:00Z' }],
      ['Australia/Sydney', '2026-03-29T09:00:00', { from: '2026-03-29T00:00:00Z', to: '2026-04-20T00:00:00Z' }],
    ] as const) {
      const spec = series({ timezone, dtstartLocal: dtstart, rrule: 'FREQ=DAILY' })
      const original = expandSeries(spec, range)
      expect(original.length).toBeGreaterThan(5)

      for (const target of original) {
        const plan = planSeriesEdit({
          series: spec,
          occurrenceLocal: target.occurrenceLocal,
          scope: 'this-and-future',
        })
        const rejoined = [
          ...expandSeries({ ...spec, rrule: plan.truncateSeriesTo }, range),
          ...expandSeries(plan.newSeries!, range),
        ].map((o) => o.occurrenceLocal)

        expect(rejoined).toEqual(original.map((o) => o.occurrenceLocal))
      }
    }
  })

  it('always produces a summary that names a consequence', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('this', 'this-and-future', 'entire-series' as const),
        fc.constantFrom(...ZONES),
        (scope, timezone) => {
          const plan = planSeriesEdit({
            series: series({ timezone }),
            occurrenceLocal: '2026-02-10T09:00:00',
            scope: scope as 'this' | 'this-and-future' | 'entire-series',
          })
          expect(plan.summary.length).toBeGreaterThan(20)
          expect(plan.summary).toMatch(/\.$/)
        },
      ),
      { numRuns: 30 },
    )
  })
})
