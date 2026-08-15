import 'server-only'
import { cookies } from 'next/headers'
import { DEMO_PREFS_COOKIE, parseDemoPrefs } from '@/lib/demo-prefs'
import { isDevFixtureEnabled } from './dev-fixture'
import type { CalendarPrefs } from './settings'

/**
 * The server half of the demo preferences: read the cookie the settings screen wrote.
 *
 * Gated on `isDevFixtureEnabled()` and not merely on "is there a cookie", so a stray
 * `cloakcal_demo_prefs` in a real user's browser can never reframe their calendar. The
 * gate checks `NODE_ENV !== 'production'` too, which Next inlines.
 *
 * THROWS when the gate is off rather than quietly handing back the defaults. Every caller
 * already wraps this in `fixtureMode ? … : …`, so the throw is unreachable today — but if
 * one of those ternaries is ever dropped, the soft version would silently replace a real
 * user's stored timezone and week start with America/New_York and Sunday, with no error
 * anywhere to say why their calendar moved. Same discipline as the leak gate, which fails
 * rather than skips: a privacy-shaped default that reports success while doing the wrong
 * thing is worse than a crash.
 */
export async function readDemoPrefs(): Promise<CalendarPrefs> {
  if (!isDevFixtureEnabled()) {
    throw new Error(
      'readDemoPrefs() was called outside the development fixture. Demo preferences are ' +
        'not a fallback for a real account: read loadWorkspacePrefs() instead.',
    )
  }
  const store = await cookies()
  return parseDemoPrefs(store.get(DEMO_PREFS_COOKIE)?.value)
}
