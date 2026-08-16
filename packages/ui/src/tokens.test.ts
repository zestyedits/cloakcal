import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CONTRAST_PAIRS,
  PRIVACY_LEVELS,
  PRIVACY_ORDER,
  contrastRatio,
  relativeLuminance,
} from './tokens.js'

/** The field values the CONTRAST_PAIRS entries are built on, named once. */
const FIELD_BG_DARK = '#10131d'
const FIELD_BG_LIGHT = '#f2f4f9'
const FIELD_BORDER_DARK = '#60626a'
const FIELD_BORDER_LIGHT = '#8a8c92'

/**
 * Accessibility is a launch requirement (spec §2), so contrast is asserted rather than
 * asserted-about. A palette that only *looks* accessible in a screenshot review will
 * drift the moment someone tweaks a shade; this fails the build instead.
 */

describe('contrast ratios meet WCAG', () => {
  it.each(CONTRAST_PAIRS)('$name meets $minimum:1', ({ foreground, background, minimum }) => {
    const ratio = contrastRatio(foreground, background)
    expect(ratio).toBeGreaterThanOrEqual(minimum)
  })
})

describe('contrast maths', () => {
  it('matches the WCAG reference points', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5)
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5)
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5)
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5)
  })

  it('is symmetric, so pair ordering cannot change a verdict', () => {
    expect(contrastRatio('#6d5cff', '#0b0d14')).toBeCloseTo(contrastRatio('#0b0d14', '#6d5cff'), 10)
  })

  it('rejects malformed hex rather than scoring it', () => {
    // The reference board misprints "#GD5CFF"; silently coercing that to a number would
    // produce NaN and a passing test. Fail loudly instead.
    expect(() => relativeLuminance('#GD5CF')).toThrow(/6-digit hex/)
  })
})

describe('privacy levels', () => {
  it('never relies on colour alone to convey state', () => {
    for (const spec of Object.values(PRIVACY_LEVELS)) {
      expect(spec.label.length).toBeGreaterThan(0)
      expect(spec.icon.length).toBeGreaterThan(0)
      expect(spec.consequence.length).toBeGreaterThan(0)
    }
  })

  it('states each consequence from the recipient point of view', () => {
    // Spec §2: privacy changes must explain the result in plain language. Every
    // consequence string is about what THEY see, not about internal mechanics.
    for (const spec of Object.values(PRIVACY_LEVELS)) {
      expect(spec.consequence.toLowerCase()).toMatch(/\bthey\b/)
      expect(spec.consequence).toMatch(/\.$/)
    }
  })

  it('uses distinguishable colours for adjacent levels', () => {
    // Adjacent privacy states sit next to each other in pickers and legends. If two are
    // near-identical, the colour is decorative rather than informative.
    for (let i = 0; i < PRIVACY_ORDER.length - 1; i += 1) {
      const a = PRIVACY_LEVELS[PRIVACY_ORDER[i]!]!.color
      const b = PRIVACY_LEVELS[PRIVACY_ORDER[i + 1]!]!.color
      expect(contrastRatio(a, b)).toBeGreaterThan(1.3)
    }
  })

  it('covers every level exactly once, in order', () => {
    expect([...PRIVACY_ORDER].sort()).toEqual(Object.keys(PRIVACY_LEVELS).sort())
    expect(PRIVACY_ORDER).toHaveLength(new Set(PRIVACY_ORDER).size)
  })
})

/**
 * The composited hexes in tokens.ts actually match what tokens.css declares.
 *
 * Every alpha ink in CONTRAST_PAIRS is a HAND-COMPUTED mirror of a rule in tokens.css —
 * `rgba(245,246,250,0.72) over #10131d` is a comment, not a calculation, and nothing has
 * ever checked that the comment is true. That is a real gap rather than a hypothetical: the
 * pairs are the only thing standing between this palette and the AA failures it has shipped
 * four times, and a pair measuring a colour the stylesheet no longer uses passes while
 * checking nothing.
 *
 * Scoped to the field tokens, which are the ones introduced with this test and the ones
 * whose numbers were worked out by hand. Extending it to the privacy chip composites is
 * worth doing and is deliberately not smuggled in here.
 */
describe('the field tokens in tokens.ts match tokens.css', () => {
  const css = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8')

  /** Strip comments first: several of them contain example values in token syntax. */
  const rules = css.replace(/\/\*[\s\S]*?\*\//gu, '')

  /** Both declarations of a custom property, in source order: dark block, then light. */
  const declarations = (name: string): string[] =>
    [...rules.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'gu'))].map((m) => m[1]!.trim())

  const composite = (rgba: string, background: string): string => {
    const parts = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/u.exec(rgba)
    if (parts === null) throw new Error(`not an rgba value: ${rgba}`)
    const alpha = Number(parts[4])
    const back = [1, 3, 5].map((i) => parseInt(background.slice(i, i + 2), 16))
    return `#${[1, 2, 3]
      .map((c, i) => Math.round(Number(parts[c]) * alpha + back[i]! * (1 - alpha)))
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')}`
  }

  it('found exactly one dark and one light declaration of each', () => {
    // Guards the assertions below from passing vacuously if a token is renamed.
    expect(declarations('--field-bg')).toHaveLength(2)
    expect(declarations('--field-border')).toHaveLength(2)
  })

  it('uses the fill the pairs are measured against', () => {
    const [dark, light] = declarations('--field-bg')
    expect(dark).toBe(FIELD_BG_DARK)
    expect(light).toBe(FIELD_BG_LIGHT)
  })

  it('composites the border to the hex the 3:1 pair claims', () => {
    const [dark, light] = declarations('--field-border')
    expect(composite(dark!, FIELD_BG_DARK)).toBe(FIELD_BORDER_DARK)
    expect(composite(light!, FIELD_BG_LIGHT)).toBe(FIELD_BORDER_LIGHT)
  })

  it('keeps the border above 3:1 on its own fill, which is why it is not a hairline', () => {
    // The number that made the border 0.35/0.45 instead of the 0.14 it replaced. If someone
    // softens it back for looks, this is what says no.
    expect(contrastRatio(FIELD_BORDER_DARK, FIELD_BG_DARK)).toBeGreaterThanOrEqual(3)
    expect(contrastRatio(FIELD_BORDER_LIGHT, FIELD_BG_LIGHT)).toBeGreaterThanOrEqual(3)
  })
})
