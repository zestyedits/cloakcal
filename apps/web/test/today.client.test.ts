import { describe, expect, it } from 'vitest'
import { isShowingToday } from '../src/lib/today'

/**
 * The predicate behind the phone header's Today control.
 *
 * It decides whether a 44px button exists at all, so both directions cost something real: too
 * generous and the control vanishes when the user is lost, too mean and the header offers a
 * button that navigates to where they already are.
 *
 * The week cases carry the weight. Week and agenda share one fetch and one range, so "on
 * today" is anywhere in today's week — and the boundary moves with the workspace's configured
 * first day, which is the part a string compare would get wrong every time.
 */

// 2026-05-20 is a Wednesday. Sunday-start week: 17th-23rd. Monday-start week: 18th-24th.
const TODAY = '2026-05-20'

describe('an absent anchor', () => {
  it('is today, because that is what the server defaults to', () => {
    // The state every user lands in. Reading it as "not today" would put a live Today button
    // on the first screen of every session.
    for (const view of ['agenda', 'week', 'day', 'month'] as const) {
      expect(isShowingToday({ view, anchorDate: undefined, todayLocal: TODAY })).toBe(true)
    }
  })
})

describe('the day view', () => {
  it('is today only on the exact date', () => {
    expect(isShowingToday({ view: 'day', anchorDate: TODAY, todayLocal: TODAY })).toBe(true)
    expect(isShowingToday({ view: 'day', anchorDate: '2026-05-19', todayLocal: TODAY })).toBe(false)
    expect(isShowingToday({ view: 'day', anchorDate: '2026-05-21', todayLocal: TODAY })).toBe(false)
  })
})

describe('the month view', () => {
  it('compares the month, because the anchor is pinned to day 1', () => {
    expect(isShowingToday({ view: 'month', anchorDate: '2026-05-01', todayLocal: TODAY })).toBe(true)
    expect(isShowingToday({ view: 'month', anchorDate: '2026-04-01', todayLocal: TODAY })).toBe(false)
    expect(isShowingToday({ view: 'month', anchorDate: '2026-06-01', todayLocal: TODAY })).toBe(false)
  })

  it('does not confuse the same month in another year', () => {
    expect(isShowingToday({ view: 'month', anchorDate: '2025-05-01', todayLocal: TODAY })).toBe(false)
  })
})

describe('agenda and week share one range', () => {
  it('counts any day of the current week as today', () => {
    // Sunday-start: the 17th through the 23rd all sit in the week holding Wednesday the 20th.
    for (const day of ['2026-05-17', '2026-05-18', '2026-05-20', '2026-05-23']) {
      expect(isShowingToday({ view: 'week', anchorDate: day, todayLocal: TODAY })).toBe(true)
      expect(isShowingToday({ view: 'agenda', anchorDate: day, todayLocal: TODAY })).toBe(true)
    }
  })

  it('excludes the days either side of that week', () => {
    expect(isShowingToday({ view: 'week', anchorDate: '2026-05-16', todayLocal: TODAY })).toBe(false)
    expect(isShowingToday({ view: 'week', anchorDate: '2026-05-24', todayLocal: TODAY })).toBe(false)
  })

  /*
   * THE BOUNDARY MOVES WITH `weekStart`, and this is the case a string compare cannot reach.
   * Sunday the 17th is in today's week when the calendar starts on Sunday and in the PREVIOUS
   * week when it starts on Monday. A user whose calendar starts on Monday, sitting on Sunday
   * the 17th, is not looking at today and must be offered the button.
   */
  it('respects the configured first day of the week', () => {
    expect(
      isShowingToday({ view: 'week', anchorDate: '2026-05-17', todayLocal: TODAY, weekStart: 0 }),
    ).toBe(true)
    expect(
      isShowingToday({ view: 'week', anchorDate: '2026-05-17', todayLocal: TODAY, weekStart: 1 }),
    ).toBe(false)

    // And the mirror: the 24th is a Sunday, so it OPENS the next week under weekStart 0 and
    // closes the current one under weekStart 1.
    expect(
      isShowingToday({ view: 'week', anchorDate: '2026-05-24', todayLocal: TODAY, weekStart: 0 }),
    ).toBe(false)
    expect(
      isShowingToday({ view: 'week', anchorDate: '2026-05-24', todayLocal: TODAY, weekStart: 1 }),
    ).toBe(true)
  })

  /*
   * Wall-date arithmetic, never `new Date('2026-05-20')` parsed through the host zone. A month
   * boundary is where that mistake shows: for anyone west of UTC the string parse lands on the
   * previous day and the week start slides with it.
   */
  it('crosses a month boundary without drifting', () => {
    // 2026-06-01 is a Monday; the Sunday-start week holding it begins 2026-05-31.
    expect(
      isShowingToday({ view: 'week', anchorDate: '2026-05-31', todayLocal: '2026-06-01', weekStart: 0 }),
    ).toBe(true)
    expect(
      isShowingToday({ view: 'week', anchorDate: '2026-05-30', todayLocal: '2026-06-01', weekStart: 0 }),
    ).toBe(false)
  })
})
