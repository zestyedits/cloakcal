import { describe, expect, it } from 'vitest'
import { stepQuery, todayQuery, viewQuery } from '../src/lib/calendar-links'

/**
 * The one nav-query builder, pinned. Three callers (server steppers, client view
 * switch/Today, hotkeys) delegate here, so these assertions guard every one of them —
 * including the Today-from-week regression that existed because two builders disagreed.
 *
 * The `view=agenda` assertions below look redundant and are the opposite. Every builder
 * used to OMIT the view param for agenda, because the server's fallback was agenda and the
 * param was therefore noise. Migration 0022 gave the workspace a stored `default_view`,
 * which the server now uses for the absent case, so an agenda link with no view param
 * resolved to whatever the user had chosen instead — clicking Agenda with a month default
 * kept you on Month. Do not "simplify" these back to a shorter query.
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

  it('steps agenda and week by seven days, both naming their view', () => {
    expect(stepQuery('2026-05-19', 'agenda', -1, 'owner')).toEqual({
      date: '2026-05-12',
      view: 'agenda',
    })
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

  it('names the agenda too, and never carries a date', () => {
    expect(todayQuery('agenda', 'owner')).toEqual({ view: 'agenda' })
  })

  it('carries the audience', () => {
    expect(todayQuery('day', 'contact:alex')).toEqual({ view: 'day', as: 'contact:alex' })
  })
})

describe('viewQuery', () => {
  it('keeps the anchor and always names the view', () => {
    expect(viewQuery('agenda', '2026-05-19', 'owner')).toEqual({
      date: '2026-05-19',
      view: 'agenda',
    })
    expect(viewQuery('month', '2026-05-19', 'contact:alex')).toEqual({
      date: '2026-05-19',
      view: 'month',
      as: 'contact:alex',
    })
  })

  it('omits the date when there is no anchor', () => {
    expect(viewQuery('week', undefined, 'owner')).toEqual({ view: 'week' })
  })

  /**
   * The regression itself, stated as a test. A workspace whose default_view is month
   * must still be able to reach the agenda by clicking Agenda, which is only true while
   * the link says so out loud.
   */
  it('reaches the agenda from a month default, because it says view=agenda', () => {
    expect(viewQuery('agenda', '2026-05-19', 'owner')['view']).toBe('agenda')
    expect(todayQuery('agenda', 'owner')['view']).toBe('agenda')
    expect(stepQuery('2026-05-19', 'agenda', 1, 'owner')['view']).toBe('agenda')
  })
})
