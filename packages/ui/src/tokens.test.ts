import { describe, expect, it } from 'vitest'
import {
  CONTRAST_PAIRS,
  PRIVACY_LEVELS,
  PRIVACY_ORDER,
  contrastRatio,
  relativeLuminance,
} from './tokens.js'

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
