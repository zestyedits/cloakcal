import 'server-only'
import { cookies } from 'next/headers'
import { DEMO_DEFAULT_PREFS, DEMO_PREFS_COOKIE, parseDemoPrefs } from '@/lib/demo-prefs'
import { isDevFixtureEnabled } from './dev-fixture'
import type { CalendarPrefs } from './settings'

/**
 * The server half of the demo preferences: read the cookie the settings screen wrote.
 *
 * Gated on `isDevFixtureEnabled()` and not merely on "is there a cookie", so a stray
 * `cloakcal_demo_prefs` in a real user's browser can never reframe their calendar. The
 * gate checks `NODE_ENV !== 'production'` too, which Next inlines, so this returns the
 * defaults and nothing else in a production bundle.
 */
export async function readDemoPrefs(): Promise<CalendarPrefs> {
  if (!isDevFixtureEnabled()) return DEMO_DEFAULT_PREFS
  const store = await cookies()
  return parseDemoPrefs(store.get(DEMO_PREFS_COOKIE)?.value)
}
