import { describe, expect, it } from 'vitest'
import { DEMO_DEFAULT_PREFS, parseDemoPrefs } from '../src/lib/demo-prefs'
import { audienceHref } from '../src/lib/audiences'

/**
 * Two pure functions that both parse or build something from untrusted input, pinned.
 *
 * `parseDemoPrefs` reads a COOKIE, which is the most editable input surface this app has:
 * a user can type anything into it, and it survives a deploy that adds a fifth preference.
 * Only the demo depends on it, so a bad clamp cannot hurt a real account — but a bad clamp
 * is also exactly the kind of thing that goes unnoticed for months in demo-only code.
 *
 * `audienceHref` is the SECOND one-URL-builder module in this app. The first one
 * (calendar-links.ts) has a test file specifically because two builders drifted apart and
 * broke Today, so the second one gets tests before it has the chance.
 */

describe('parseDemoPrefs', () => {
  it('returns the defaults for nothing, junk, or a non-object', () => {
    expect(parseDemoPrefs(undefined)).toEqual(DEMO_DEFAULT_PREFS)
    expect(parseDemoPrefs('')).toEqual(DEMO_DEFAULT_PREFS)
    expect(parseDemoPrefs('not json at all')).toEqual(DEMO_DEFAULT_PREFS)
    expect(parseDemoPrefs(encodeURIComponent('"a string"'))).toEqual(DEMO_DEFAULT_PREFS)
    expect(parseDemoPrefs(encodeURIComponent('null'))).toEqual(DEMO_DEFAULT_PREFS)
  })

  it('round-trips a complete set', () => {
    const prefs = {
      timezone: 'Europe/Berlin',
      weekStart: 1,
      defaultView: 'month',
      keyboardShortcuts: false,
      holidayRegion: 'GB',
    }
    expect(parseDemoPrefs(encodeURIComponent(JSON.stringify(prefs)))).toEqual(prefs)
  })

  it('fills in a preference a cookie predates rather than discarding the rest', () => {
    // A cookie written before holidayRegion existed is the real-world case, not a
    // hypothetical: this one is a day old at most, but the field-by-field parse is what
    // stops the next added preference resetting the four before it.
    const older = {
      timezone: 'Europe/Berlin',
      weekStart: 1,
      defaultView: 'month',
      keyboardShortcuts: false,
    }
    expect(parseDemoPrefs(encodeURIComponent(JSON.stringify(older)))).toEqual({
      ...older,
      holidayRegion: DEMO_DEFAULT_PREFS.holidayRegion,
    })
  })

  /**
   * Field by field, not all or nothing. A cookie written before a fifth preference existed
   * must not lose the four good values because it lacks the fifth — and one hand-edited
   * garbage field must not discard its neighbours either.
   */
  it('keeps the good fields when one is garbage', () => {
    const parsed = parseDemoPrefs(
      encodeURIComponent(
        JSON.stringify({ timezone: 'Europe/Berlin', weekStart: 99, defaultView: 'sideways' }),
      ),
    )
    expect(parsed.timezone).toBe('Europe/Berlin')
    expect(parsed.weekStart).toBe(DEMO_DEFAULT_PREFS.weekStart)
    expect(parsed.defaultView).toBe(DEMO_DEFAULT_PREFS.defaultView)
    expect(parsed.keyboardShortcuts).toBe(DEMO_DEFAULT_PREFS.keyboardShortcuts)
  })

  it('clamps weekStart to a real weekday, rejecting floats and out-of-range', () => {
    const of = (weekStart: unknown) =>
      parseDemoPrefs(encodeURIComponent(JSON.stringify({ weekStart }))).weekStart
    expect(of(0)).toBe(0)
    expect(of(6)).toBe(6)
    expect(of(7)).toBe(DEMO_DEFAULT_PREFS.weekStart)
    expect(of(-1)).toBe(DEMO_DEFAULT_PREFS.weekStart)
    expect(of(2.5)).toBe(DEMO_DEFAULT_PREFS.weekStart)
    expect(of('1')).toBe(DEMO_DEFAULT_PREFS.weekStart)
  })

  it('accepts every view the rest of the app accepts, and nothing else', () => {
    // The same allowlist the URL parser and loadWorkspacePrefs use. Four copies of this
    // list is how a settings select comes to offer a value a parser silently rejects.
    for (const view of ['agenda', 'week', 'day', 'month']) {
      expect(parseDemoPrefs(encodeURIComponent(JSON.stringify({ defaultView: view }))).defaultView)
        .toBe(view)
    }
    expect(
      parseDemoPrefs(encodeURIComponent(JSON.stringify({ defaultView: 'AGENDA' }))).defaultView,
    ).toBe(DEMO_DEFAULT_PREFS.defaultView)
  })

  it('models a demo user who opted in to shortcuts, so the hotkey suite has a keyboard', () => {
    // Not the product default — WCAG 2.1.4 wants those off until asked for, and that is
    // pinned on the 0022 column. This is the fixture requirement, stated once.
    expect(DEMO_DEFAULT_PREFS.keyboardShortcuts).toBe(true)
    expect(DEMO_DEFAULT_PREFS.defaultView).toBe('agenda')
  })
})

describe('audienceHref', () => {
  it('sets the audience and keeps every other param', () => {
    expect(audienceHref('view=month&date=2026-05-19', 'contact:alex')).toBe(
      '/?view=month&date=2026-05-19&as=contact%3Aalex',
    )
  })

  it('replaces an audience rather than appending a second one', () => {
    expect(audienceHref('as=public', 'group:team')).toBe('/?as=group%3Ateam')
  })

  /**
   * Owner DELETES the param. Setting `as=owner` would work identically for the engine and
   * leave a shareable URL that says a viewer is being previewed when none is.
   */
  it('drops the param entirely for the owner, back to a bare calendar URL', () => {
    expect(audienceHref('as=contact:alex', 'owner')).toBe('/')
    expect(audienceHref('view=day&as=contact:alex', 'owner')).toBe('/?view=day')
    expect(audienceHref('', 'owner')).toBe('/')
  })
})
