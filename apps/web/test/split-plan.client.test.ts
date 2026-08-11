/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { expandSeries, type SeriesSpec } from '@cloakcal/domain'
import { UnsafeSplitError, planSplit } from '../src/lib/split-plan'

/**
 * Gate 3a — the half of split verification that needs a recurrence engine.
 *
 * These are the tests that stop a split silently eating a meeting. The SQL side proves the
 * database stored the plan faithfully; nothing over there can tell whether the plan itself
 * was sane, because Postgres cannot expand an RRULE.
 */

const series = (over: Partial<SeriesSpec> = {}): SeriesSpec => ({
  dtstartLocal: '2026-01-06T09:00:00',
  durationMinutes: 60,
  timezone: 'America/New_York',
  rrule: 'FREQ=WEEKLY;BYDAY=TU',
  ...over,
})

const AT = '2026-03-10T09:00:00'
const RANGE = { from: '2025-01-01T00:00:00Z', to: '2028-01-01T00:00:00Z' }
const NEW_ID = '11111111-1111-4111-8111-111111111111'

describe('planning a this-and-future split', () => {
  const plan = planSplit({
    series: series(),
    occurrenceLocal: AT,
    scope: 'this-and-future',
    newEventId: NEW_ID,
  })

  it('truncates the original to just before the split point', () => {
    expect(plan.truncateRrule).toMatch(/UNTIL=20260310T085959Z/)
    expect(plan.truncateRrule).not.toMatch(/COUNT=/i)
  })

  it('anchors the successor on the occurrence the user acted on', () => {
    expect(plan.newDtstartLocal).toBe(AT)
    expect(plan.newRrule).toBe('FREQ=WEEKLY;BYDAY=TU')
  })

  it('resolves the successor start through the DST policy, not the host clock', () => {
    // 2026-03-10 is after the US spring-forward, so 09:00 New York is 13:00Z rather than the
    // 14:00Z it would be in January. Getting this from the domain rather than by arithmetic
    // is the whole reason instantsFor exists.
    expect(plan.newStartUtc).toBe('2026-03-10T13:00:00Z')
    expect(plan.newEndUtc).toBe('2026-03-10T14:00:00Z')
  })

  it('rejoins to exactly the original occurrence set', () => {
    const original = expandSeries(series(), RANGE).map((o) => o.occurrenceLocal)
    const before = expandSeries({ ...series(), rrule: plan.truncateRrule }, RANGE).map(
      (o) => o.occurrenceLocal,
    )
    const after = expandSeries(
      { ...series(), dtstartLocal: plan.newDtstartLocal, rrule: plan.newRrule },
      RANGE,
    ).map((o) => o.occurrenceLocal)

    expect([...before, ...after]).toEqual(original)
  })
})

describe('planning a single-occurrence detach', () => {
  const plan = planSplit({
    series: series(),
    occurrenceLocal: '2026-02-10T09:00:00',
    scope: 'this',
    newEventId: NEW_ID,
  })

  it('leaves the rule alone and produces a non-repeating row', () => {
    expect(plan.truncateRrule).toBeNull()
    expect(plan.newRrule).toBeNull()
    expect(plan.newDtstartLocal).toBe('2026-02-10T09:00:00')
  })
})

describe('refusals', () => {
  it('will not split an event that does not repeat', () => {
    expect(() =>
      planSplit({
        series: series({ rrule: null }),
        occurrenceLocal: AT,
        scope: 'this-and-future',
        newEventId: NEW_ID,
      }),
    ).toThrow(UnsafeSplitError)
  })

  it('refuses a bounded series whose successor would be empty', () => {
    // COUNT=4 runs out well before June. Splitting there would produce a successor with no
    // occurrences at all, which is a silent deletion of nothing dressed up as an edit.
    expect(() =>
      planSplit({
        series: series({ rrule: 'FREQ=WEEKLY;BYDAY=TU;COUNT=4' }),
        occurrenceLocal: '2026-06-02T09:00:00',
        scope: 'this-and-future',
        newEventId: NEW_ID,
      }),
    ).toThrow()
  })

  it('keeps a bounded series at the same total across the split', () => {
    const bounded = series({ rrule: 'FREQ=WEEKLY;BYDAY=TU;COUNT=10' })
    const plan = planSplit({
      series: bounded,
      occurrenceLocal: '2026-01-27T09:00:00',
      scope: 'this-and-future',
      newEventId: NEW_ID,
    })
    // 3 before, 7 after. The successor's COUNT is rewritten rather than inherited; without
    // that the split would manufacture three meetings nobody scheduled.
    expect(plan.newRrule).toBe('FREQ=WEEKLY;BYDAY=TU;COUNT=7')
  })
})

describe('a retiming split', () => {
  const retimed = planSplit({
    series: series(),
    occurrenceLocal: AT,
    scope: 'this-and-future',
    newEventId: NEW_ID,
    timing: {
      dtstartLocal: '2026-03-10T14:30:00',
      startUtc: '2026-03-10T18:30:00Z',
      endUtc: '2026-03-10T19:30:00Z',
    },
  })

  it('moves the successor without touching what came before', () => {
    expect(retimed.newDtstartLocal).toBe('2026-03-10T14:30:00')
    const before = expandSeries({ ...series(), rrule: retimed.truncateRrule }, RANGE).map(
      (o) => o.occurrenceLocal,
    )
    expect(before.every((o) => o < AT)).toBe(true)
    expect(before.every((o) => o.endsWith('T09:00:00'))).toBe(true)
  })

  it('keeps the same number of future occurrences, because a move is not a deletion', () => {
    const future = expandSeries(series(), RANGE)
      .map((o) => o.occurrenceLocal)
      .filter((o) => o >= AT)
    const moved = expandSeries(
      { ...series(), dtstartLocal: retimed.newDtstartLocal, rrule: retimed.newRrule },
      RANGE,
    )
    expect(moved).toHaveLength(future.length)
  })

  it('refuses to move a fixed-weekday series onto a different weekday', () => {
    // The subtle one. `BYDAY=TU` keeps generating Tuesdays no matter where the anchor is
    // moved to, so dragging this series to a Wednesday produces a row whose stored anchor
    // disagrees with the dates it actually renders — the event appears to move, then shows
    // up on the old weekday. The occurrence COUNT is unchanged, so only the
    // does-it-start-where-I-put-it check can see this.
    let thrown: unknown
    try {
      planSplit({
        series: series({ rrule: 'FREQ=WEEKLY;BYDAY=TU' }),
        occurrenceLocal: '2026-03-10T09:00:00',
        scope: 'this-and-future',
        newEventId: NEW_ID,
        timing: {
          dtstartLocal: '2026-03-11T09:00:00', // a Wednesday
          startUtc: '2026-03-11T13:00:00Z',
          endUtc: '2026-03-11T14:00:00Z',
        },
      })
    } catch (caught) {
      thrown = caught
    }
    expect(thrown).toBeInstanceOf(UnsafeSplitError)
    // The message has to name the day it WOULD land on, or the user cannot tell why.
    expect((thrown as Error).message).toMatch(/2026-03-17/)
  })

  it('allows a time-of-day move on the same weekday', () => {
    // The ordinary case, and proof the check above is not simply rejecting every retime.
    expect(() =>
      planSplit({
        series: series(),
        occurrenceLocal: AT,
        scope: 'this-and-future',
        newEventId: NEW_ID,
        timing: {
          dtstartLocal: '2026-03-10T16:00:00',
          startUtc: '2026-03-10T20:00:00Z',
          endUtc: '2026-03-10T21:00:00Z',
        },
      }),
    ).not.toThrow()
  })
})
