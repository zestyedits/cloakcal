import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The calendar's loading fallback must be the full shell, not a bare skeleton.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SOURCE-LEVEL TEST, WHICH IS UNUSUAL AND DELIBERATE
 * ---------------------------------------------------------------------------
 *
 * The state under test exists only between a navigation and its response, and whether it
 * ever PAINTS depends on how the RSC chunks land relative to React's commit: hold the
 * whole response in a test and fallback and content commit together, so the fallback is
 * skipped entirely. A visibility assertion is therefore a race against server speed —
 * it passed seven times in a row here and then failed under a longer hold, which is the
 * definition of a flake waiting for CI. Same shape as signup-enumeration: when the
 * behaviour cannot be observed deterministically, pin the mechanism in the source.
 *
 * The regression this forbids is the pre-2026-08 fallback — a grey column with NO header,
 * NO sidebar, NO nav, so arriving at `/` from /people or /settings swapped the whole
 * screen for a third, alien page: a freeze, then a teleport. The fix was the
 * settings-loading lesson: the fallback wears the calendar's REAL chrome (same
 * stylesheet), and only data shimmers. e2e/nav-feel.spec.ts asserts the user-facing half
 * (the chrome is never absent for a frame) whenever timing exposes the fallback at all.
 */

/* Through a helper with a parameter, exactly like signup-enumeration: Vite rewrites a
   LITERAL `new URL('…', import.meta.url)` as an asset reference, and in the jsdom
   project that resolves to an http URL that fileURLToPath then rejects. A variable
   defeats the static pattern match. */
const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

const source = read('../src/app/loading.tsx')

describe('the root loading fallback', () => {
  it('renders the real shell chrome, from the real stylesheet', () => {
    // The calendar's own stylesheet, not a lookalike: geometry cannot drift apart if
    // there is only one source of it.
    expect(source).toContain("from '@/components/calendar-screen.module.css'")
    // The chrome itself: a header (with the shell grid around it), and the mobile nav.
    expect(source).toContain('cal.shell')
    expect(source).toContain('<header')
    expect(source).toContain('cal.nav')
  })

  it('draws its view controls from the shared orderings, not a second copy', () => {
    // calendar-views.ts is the single source of which views exist, in what order, under
    // which labels. The fallback's job is to draw exactly the chrome the screen is about
    // to commit, so BOTH must consume it — a hardcoded list in either file is the drift
    // that flashes four segments while the real header renders five.
    expect(source).toContain("from '@/lib/calendar-views'")
    expect(read('../src/components/calendar-screen.tsx')).toContain(
      "from '@/lib/calendar-views'",
    )
  })

  it('marks the main region busy, once, instead of narrating shimmer', () => {
    expect(source).toContain('aria-busy="true"')
    expect(source).toContain('aria-label="Loading your calendar"')
  })

  it('keeps the sidebar and inert chrome out of the accessibility tree', () => {
    // Fake controls that cannot be operated must not be offered to a screen reader;
    // the shapes are aria-hidden and the live controls (lockup, theme) are real.
    expect(source.match(/aria-hidden="true"/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })
})
