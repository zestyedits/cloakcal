import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Single-key shortcuts must stay OFF until a user asks for them, and the RENDER default is
 * a separate fact from the column default.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SOURCE-LEVEL TEST, WHICH IS UNUSUAL AND DELIBERATE
 * ---------------------------------------------------------------------------
 *
 * `packages/db/test/workspace-prefs.test.ts` already pins `keyboard_shortcuts` defaulting to
 * false on the 0022 column, and that is the right home for it. But it says nothing about
 * what `app/page.tsx` does with a MISSING preference — a workspace row that predates 0022,
 * a user whose prefs query returned null, the fixture. Write `?? true` there and every one
 * of those users gets single-key bindings they never opted into, while the db test stays
 * green. Two different defaults, one of them untested; this is the untested one.
 *
 * It is source-level because the alternative is not available. `page.tsx` is an async Server
 * Component that reaches Supabase before it renders anything, so there is no unit boundary
 * to assert against, and the e2e projects all run with the fixture — which deliberately
 * models an opted-IN user so the hotkey suite has a live keyboard to test. The one
 * environment that could observe the off-by-default behaviourally is the one environment
 * that turns it on. Same reasoning as signup-enumeration and loading-shell.
 *
 * ---------------------------------------------------------------------------
 * WHY THE GUARANTEE MATTERS
 * ---------------------------------------------------------------------------
 *
 * WCAG 2.1.4 (Character Key Shortcuts) offers three ways to satisfy it: let the user turn
 * the bindings off, let them remap, or scope them to focus. This app takes the first, so the
 * opt-in IS the conformance mechanism rather than a preference — an on-by-default single-key
 * binding means a speech-input user navigating by dictation moves the calendar every time
 * they say a word beginning with a bound letter. Claiming route one while defaulting to on
 * would make the claim false.
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

const PAGE = read('../src/app/page.tsx')

describe('the keyboard shortcut opt-in', () => {
  it('falls back to OFF when no preference is stored', () => {
    expect(PAGE).toContain('hotkeysEnabled={prefs?.keyboardShortcuts ?? false}')
  })

  /**
   * The specific regression, named. `?? fixtureMode` was the real spelling here until the
   * demo gained a write path: one preference carrying an escape hatch that no other
   * preference had. It is gone, and the demo now models an opted-in user by DEFAULTING to
   * on in DEMO_DEFAULT_PREFS — which keeps the hotkey suite working without teaching the
   * production render that "no preference" can ever mean "on".
   */
  it('does not reach for the fixture flag to decide it', () => {
    expect(PAGE).not.toContain('keyboardShortcuts ?? fixtureMode')
    expect(PAGE).not.toContain('hotkeysEnabled={true}')
  })
})
