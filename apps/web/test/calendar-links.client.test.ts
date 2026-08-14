import { describe, expect, it } from 'vitest'
import { stepQuery, todayQuery, viewQuery } from '../src/lib/calendar-links'

/**
 * The one nav-query builder, pinned. Three callers (server steppers, client view
 * switch/Today, hotkeys) delegate here, so these assertions guard every one of them —
 * including the Today-from-week regression that existed because two builders disagreed.
 */

describe('stepQuery', () => {
  it('pins month steps to day 1, so short months cannot drift', () => {
    expect(stepQuery('2026-01-31', 'month', 1, 'owner')).toEqual({
      date: '2026-02-01',
      view: 'month',
    })
  })

  it('steps a day view by single days', () => {
    expect(stepQuery('2026-05-19', 'day', 1, 'owner')).toEqual({
      date: '2026-05-20',
      view: 'day',
    })
  })

  it('steps agenda and week by seven days, agenda without a view param', () => {
    expect(stepQuery('2026-05-19', 'agenda', -1, 'owner')).toEqual({ date: '2026-05-12' })
    expect(stepQuery('2026-05-19', 'week', 1, 'owner')).toEqual({
      date: '2026-05-26',
      view: 'week',
    })
  })

  it('carries the audience so View As survives navigation', () => {
    expect(stepQuery('2026-05-19', 'day', 1, 'contact:alex')).toEqual({
      date: '2026-05-20',
      view: 'day',
      as: 'contact:alex',
    })
  })
})

describe('todayQuery', () => {
  it('keeps the week view — the regression that shipped', () => {
    expect(todayQuery('week', 'owner')).toEqual({ view: 'week' })
  })

  it('is minimal on the agenda and never carries a date', () => {
    expect(todayQuery('agenda', 'owner')).toEqual({})
  })

  it('carries the audience', () => {
    expect(todayQuery('day', 'contact:alex')).toEqual({ view: 'day', as: 'contact:alex' })
  })
})

describe('viewQuery', () => {
  it('keeps the anchor and drops the view param for agenda', () => {
    expect(viewQuery('agenda', '2026-05-19', 'owner')).toEqual({ date: '2026-05-19' })
    expect(viewQuery('month', '2026-05-19', 'contact:alex')).toEqual({
      date: '2026-05-19',
      view: 'month',
      as: 'contact:alex',
    })
  })

  it('omits the date when there is no anchor', () => {
    expect(viewQuery('week', undefined, 'owner')).toEqual({ view: 'week' })
  })
})
