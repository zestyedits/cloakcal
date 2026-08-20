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

/*
 * THE FALLBACK'S CHROME IS THE REAL CHROME, and these four are the ones that drifted.
 *
 * After the 2026-08-20 mobile redesign this file's subject still drew the PREVIOUS phone
 * header: the wordmark where the destination shows the mark alone, a theme toggle the phone
 * header hides, no Settings control where the phone header has one, and a 120px View As card
 * standing in for a 52px row. So the shell visibly changed at the moment of handoff — the
 * one thing a loading state exists not to do.
 *
 * Asserted on the SOURCE for the reason this file already gives at length: whether the
 * fallback ever PAINTS depends on how the RSC chunks land relative to React's commit, and a
 * held navigation does not help — Next keeps the previous route painted until the payload
 * arrives rather than rendering the boundary. Measured, not assumed.
 *
 * The other half lives in `e2e/loading-continuity.spec.ts`, which asserts that the values
 * pinned here are the values the DESTINATION actually has, so this is compared against
 * reality rather than against what its author believed.
 */
describe("the fallback wears the destination's phone chrome", () => {
  /*
   * COMMENTS STRIPPED FIRST, and LINE comments before BLOCK ones.
   *
   * The prose in loading.tsx explains the very drift these tests pin, so it contains
   * `<ThemeToggle />` as a QUOTATION. A positional check against the raw file found the
   * comment's copy, decided the toggle came before its wrapper, and failed on correct code.
   *
   * The ordering is the repo's existing rule: a line comment mentioning a path like an api
   * wildcard opens a block that the block matcher then closes at the next block-comment
   * terminator it finds, swallowing everything between. Same helper as legal-claims and
   * billing-boundary. Note this comment does not SPELL that terminator -- writing it inside
   * a block comment ends the comment, which is the same trap one layer up, and it cost a
   * transform error here before the sentence was reworded.
   */
  const code = (source: string): string =>
    source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

  const markup = code(source)

  it('collapses the lockup exactly as the real header does', () => {
    // Without `compact` this draws the wordmark on a phone, which is ~110px of header the
    // destination does not spend -- a width jump in the one place the flag exists to prevent.
    expect(markup).toContain('<CloakHomeLink size="sm" compact />')
  })

  it('carries the Settings control the phone header carries', () => {
    expect(markup).toContain('cal.headerSettings')
    expect(markup).toContain('SettingsMark')
    // From the shared module, never a second copy of the glyph: two copies of a mark is how
    // this file drifted from the header in the first place.
    expect(source).toContain("from '@/components/settings-mark'")
  })

  it('hides the theme toggle behind the same wrapper the real header uses', () => {
    expect(markup).toContain('cal.headerTheme')
    /*
     * A BARE <ThemeToggle /> is the defect. `.toggle` sets its own `display`, so only the
     * wrapper can hide it below 900px -- a same-specificity override loses on CSS-module
     * import order, which is the trap the Today button already paid for. Without the
     * wrapper the fallback shows a control on a phone that the destination does not have.
     *
     * Positional, because the toggle must be INSIDE the wrapper and a substring check
     * alone cannot say that.
     */
    const wrapper = markup.indexOf('cal.headerTheme')
    const toggle = markup.indexOf('<ThemeToggle')
    expect(wrapper).toBeGreaterThan(-1)
    expect(toggle).toBeGreaterThan(wrapper)
    expect(toggle - wrapper).toBeLessThan(80)
  })

  it('holds the phone audience row and the desktop card separately', () => {
    // One unconditional 6rem shape stood in for both, so the phone reserved 120px where the
    // destination uses 52px and 68px of prelude vanished at handoff.
    expect(markup).toContain('audienceShape')
    expect(markup).toContain('viewAsShape')
  })
})
