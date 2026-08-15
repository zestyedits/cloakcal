import type { WeekStart } from '@/server/range'
import type { CalendarPrefs, CalendarViewPref } from '@/server/settings'

/**
 * Preferences for the demo calendar, kept in a COOKIE.
 *
 * Why they exist at all: without a signed-in account there is no `workspaces` row, so
 * `loadWorkspacePrefs()` returned null and every preference control on /settings rendered
 * disabled — timezone, week start, default view, shortcuts, the lot. A settings page that
 * is entirely grey reads as unfinished rather than as unauthenticated, and it made the one
 * feature this pass exists to expose ("open on the view I chose") impossible to even try
 * without going through the throwaway-account recipe.
 *
 * Why a cookie and not localStorage: the view is resolved SERVER-side in `app/page.tsx`,
 * because the timezone frames which instant range a week spans before anything renders. A
 * browser-only store could not reach that decision without a visible flash of the wrong
 * view, so the store has to be one the server can read. `/` and `/settings` are both
 * force-dynamic and already touch cookies, so this costs no staticness.
 *
 * What is NOT in here: anything encrypted. These four values are the same Tier A facts
 * that live in plaintext columns on `workspaces` for real accounts (0018, 0022) — display
 * framing, nothing about an event. Rule 2 is untouched by construction.
 *
 * The whole module is dev-only in practice: every caller gates on `isDevFixtureEnabled()`,
 * which also checks `NODE_ENV !== 'production'`, and Next inlines that at build time.
 */

export const DEMO_PREFS_COOKIE = 'cloakcal_demo_prefs'

/**
 * The demo's starting point, which is also the historical fixture behaviour, deliberately.
 *
 * `keyboardShortcuts: true` is not a preference so much as a fixture requirement: the
 * hotkey specs need the bindings live, and `page.tsx` used to spell that as
 * `prefs?.keyboardShortcuts ?? fixtureMode` — a special case for one pref that no other
 * pref got. Stating it as the demo's default retires the special case.
 */
export const DEMO_DEFAULT_PREFS: CalendarPrefs = {
  timezone: 'America/New_York',
  weekStart: 0,
  defaultView: 'agenda',
  keyboardShortcuts: true,
}

const VIEWS: readonly CalendarViewPref[] = ['agenda', 'week', 'day', 'month']

/**
 * Parse the cookie into prefs, falling back field by field.
 *
 * Field-by-field rather than all-or-nothing on purpose: a cookie is user-editable and
 * survives a deploy that adds a fifth preference, so one unrecognised value must not
 * discard the four good ones. Every field is clamped to something representable, which is
 * the same discipline `loadWorkspacePrefs` applies to a column that already has a CHECK
 * constraint behind it.
 */
export function parseDemoPrefs(raw: string | undefined): CalendarPrefs {
  if (raw === undefined || raw === '') return DEMO_DEFAULT_PREFS

  let parsed: unknown
  try {
    parsed = JSON.parse(decodeURIComponent(raw))
  } catch {
    return DEMO_DEFAULT_PREFS
  }
  if (typeof parsed !== 'object' || parsed === null) return DEMO_DEFAULT_PREFS

  const record = parsed as Record<string, unknown>

  const timezone =
    typeof record['timezone'] === 'string' && record['timezone'] !== ''
      ? record['timezone']
      : DEMO_DEFAULT_PREFS.timezone

  const rawWeekStart = record['weekStart']
  const weekStart =
    typeof rawWeekStart === 'number' && Number.isInteger(rawWeekStart) &&
    rawWeekStart >= 0 && rawWeekStart <= 6
      ? (rawWeekStart as WeekStart)
      : DEMO_DEFAULT_PREFS.weekStart

  const defaultView = VIEWS.includes(record['defaultView'] as CalendarViewPref)
    ? (record['defaultView'] as CalendarViewPref)
    : DEMO_DEFAULT_PREFS.defaultView

  const keyboardShortcuts =
    typeof record['keyboardShortcuts'] === 'boolean'
      ? record['keyboardShortcuts']
      : DEMO_DEFAULT_PREFS.keyboardShortcuts

  return { timezone, weekStart, defaultView, keyboardShortcuts }
}

/** What the browser currently holds, for callers that need to merge into it. */
export function readDemoPrefsFromDocument(): CalendarPrefs {
  if (typeof document === 'undefined') return DEMO_DEFAULT_PREFS
  const match = document.cookie
    .split('; ')
    .find((part) => part.startsWith(`${DEMO_PREFS_COOKIE}=`))
  return parseDemoPrefs(match?.slice(DEMO_PREFS_COOKIE.length + 1))
}

/**
 * Change some demo prefs from the browser, keeping the rest.
 *
 * It re-reads before writing rather than taking the current values as an argument, because
 * a cookie has no merge semantics of its own: every write replaces the whole value, and a
 * caller that only knows about one preference would silently reset the other three. That
 * also means a control needs to know nothing except the field it owns.
 *
 * `max-age` of a day because demo state that outlives the reason you set it is a support
 * question waiting to happen, and `SameSite=Lax` because nothing here should ride along on
 * a cross-site request. No-ops outside a browser, so a stray server-side call is inert
 * rather than a crash.
 */
export function updateDemoPrefs(patch: Partial<CalendarPrefs>): void {
  if (typeof document === 'undefined') return
  const next: CalendarPrefs = { ...readDemoPrefsFromDocument(), ...patch }
  const value = encodeURIComponent(JSON.stringify(next))
  document.cookie = `${DEMO_PREFS_COOKIE}=${value}; path=/; max-age=86400; samesite=lax`
}
