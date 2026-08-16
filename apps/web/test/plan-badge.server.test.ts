import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The sidebar plan badge, pinned at the source, because no environment here can render it.
 *
 * The account cluster in calendar-screen.tsx is gated on a real session — the dev fixture
 * has none, so the cluster never renders under Playwright, and neither the axe scan nor the
 * 44px sweep nor any screenshot has ever seen that row. That is why `.accountEmail`'s
 * light-theme contrast problem survived as long as it did: nothing looked.
 *
 * Colour is covered where CLAUDE.md says colour belongs, in CONTRAST_PAIRS, and the opaque
 * badge washes are what make that check independent of which surface it lands on. What is
 * left is LAYOUT and the choice of palette, and those are pinned here.
 *
 * The other half of this file is the client side of migration 0024's anti-write test: the
 * database refuses a plan write, and this refuses one ever being attempted.
 */

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

/**
 * Comments stripped before anything is asserted against a stylesheet.
 *
 * Not a tidy-up: the first version of "is rectangular, never a pill" failed on this file's
 * OWN comment, which says the badge is never --radius-full. A source-level test that reads
 * prose as code punishes explaining yourself, which in this repo is exactly backwards.
 */
const rules = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//gu, '')

const screen = read('../src/components/calendar-screen.tsx')
const screenCss = rules('../src/components/calendar-screen.module.css')
const badgeCss = rules('../src/components/ui/plan-badge.module.css')
const badge = read('../src/components/ui/plan-badge.tsx')

describe('the badge in the account cluster', () => {
  it('renders inside the account row, beside the email', () => {
    // Loose on purpose: `<PlanBadge` rather than the exact element, so adding a prop or
    // reflowing the JSX does not red a test whose subject is PLACEMENT. Inside .accountMeta,
    // which is the one-line email-and-badge pair — a third line inside a 44px row is a
    // cramped row, not a hierarchy.
    expect(screen).toMatch(/accountMeta[\s\S]*?<PlanBadge/u)
  })

  it('gives both the row and the email a min-width of 0', () => {
    /*
     * BOTH, and this is the assertion no viewport test can make here. A flex item's default
     * min-width is content-based, and setting it on the CONTAINER does nothing for the item
     * — the same rule that sized the settings summary cards to title-plus-state and pushed
     * /settings into horizontal overflow at 390px. Here it would widen the sidebar's fixed
     * track instead: the same bug wearing a different column, on the one row nothing in the
     * suite renders.
     */
    expect(badgeCss).toMatch(/\.badge\s*\{[^}]*flex:\s*none/u)
    expect(screenCss).toMatch(/\.accountMeta\s*\{[^}]*min-width:\s*0/u)
    expect(screenCss).toMatch(/\.accountEmail\s*\{[^}]*min-width:\s*0/u)
  })

  it('keeps the email on secondary ink, not tertiary', () => {
    // Light-theme tertiary at 12px is under AA. This row is invisible to axe, so the only
    // thing standing between it and a regression is this line.
    expect(screenCss).toMatch(/\.accountEmail\s*\{[^}]*color:\s*var\(--text-secondary\)/u)
  })
})

describe('the badge’s material', () => {
  it('never wears a privacy colour', () => {
    /*
     * The four privacy inks are learned MEANING in this product — tokens.css requires a
     * level to look identical everywhere it appears. A billing tier in the "Limited
     * details" indigo would teach a false equivalence on the one palette that cannot afford
     * to blur, and would put something indistinguishable from an event's privacy chip in
     * the sidebar.
     */
    expect(badgeCss).not.toMatch(/--privacy-/u)
  })

  it('is rectangular, never a pill', () => {
    expect(badgeCss).toContain('border-radius: var(--radius-sm)')
    expect(badgeCss).not.toMatch(/--radius-full/u)
  })

  it('carries its variant on a data attribute rather than a class per plan', () => {
    // Same mechanism as PrivacyChip's data-level: one class, N attribute selectors.
    expect(badge).toContain('data-plan={plan}')
    expect(badgeCss).toContain("[data-plan='free']")
    expect(badgeCss).toContain("[data-plan='pro']")
  })

  it('is not a link', () => {
    // A 12px tag cannot carry a 44px target, and the sidebar is exactly where the sweep
    // would never catch one.
    expect(badge).not.toMatch(/<Link|<a\s/u)
  })
})

describe('nothing in the app writes a plan', () => {
  it('never inserts, updates, upserts or deletes a subscription', async () => {
    /*
     * The client half of migration 0024's anti-write test. The database refuses these
     * outright — there is no insert, update or delete policy and the privileges are revoked
     * — so this does not add protection; it adds a FAILURE THAT ARRIVES EARLIER, at the
     * moment somebody writes the call, rather than as an inexplicable "permission denied"
     * in production. The plan is written by the billing role in ADR 0007 and by nothing
     * else, ever.
     */
    const { globSync } = await import('node:fs')
    const src = fileURLToPath(new URL('../src', import.meta.url))
    const files = globSync('**/*.{ts,tsx}', { cwd: src }).map((f) => `${src}/${f}`)
    expect(files.length).toBeGreaterThan(0)

    const offenders = files.filter((file) => {
      const body = readFileSync(file, 'utf8')
      return /from\(\s*['"]subscriptions['"]\s*\)[\s\S]{0,200}\.(insert|update|upsert|delete)\(/u.test(
        body,
      )
    })
    expect(offenders).toEqual([])
  })

  it('never reads a plan out of a cookie', () => {
    /*
     * lib/demo-prefs.ts draws its line at display framing — the Tier A facts a real account
     * keeps in plaintext columns. A plan is the one fact in this product that is not the
     * user's to state, and a cookie-backed one would model precisely the capability 0024
     * spends a table to remove.
     */
    // Comments stripped, for the reason `rules()` exists above: demo-prefs.ts is entitled to
    // EXPLAIN in prose why a plan does not live there, and a test that reads prose as code
    // would red on the sentence that documents the rule it is enforcing.
    const demoPrefs = read('../src/lib/demo-prefs.ts')
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/\/\/.*$/gmu, '')
    expect(demoPrefs).not.toMatch(/\bplan\b/iu)
  })
})
