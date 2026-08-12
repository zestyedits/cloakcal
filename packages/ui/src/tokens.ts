/**
 * Typed mirror of tokens.css.
 *
 * Only values that code needs to reason about live here — privacy levels especially,
 * because they carry meaning and are asserted against in tests. Layout values stay in
 * CSS where they belong; duplicating the whole file in TypeScript would create two
 * sources of truth and they would drift.
 */

export type PrivacyLevel = 'full' | 'limited' | 'busy' | 'hidden'

export interface PrivacyLevelSpec {
  readonly level: PrivacyLevel
  /** Resolved hex, kept in sync with the --privacy-* custom properties. */
  readonly color: string
  /** Short label. Wording is deliberately plain — see spec §2 on plain-language privacy. */
  readonly label: string
  /** One-line consequence, stated from the recipient's point of view. */
  readonly consequence: string
  /**
   * Icon name. Every privacy state carries an icon AND a label, so colour is never the
   * sole carrier of meaning (WCAG 1.4.1). A component that renders the colour without
   * both of these is a defect.
   */
  readonly icon: string
}

export const PRIVACY_LEVELS: Readonly<Record<PrivacyLevel, PrivacyLevelSpec>> = {
  full: {
    level: 'full',
    color: '#22d3a6',
    label: 'Full details',
    consequence: 'They see everything about this event.',
    icon: 'eye',
  },
  limited: {
    level: 'limited',
    color: '#6d5cff',
    label: 'Limited details',
    consequence: 'They see the title and time. Location, notes and attendees stay hidden.',
    icon: 'eye-half',
  },
  busy: {
    level: 'busy',
    color: '#f5a524',
    label: 'Busy',
    consequence: 'They see that you are busy, and nothing else.',
    icon: 'clock',
  },
  hidden: {
    level: 'hidden',
    color: '#2a2f45',
    label: 'Hidden',
    consequence: 'They do not see this event at all.',
    icon: 'eye-off',
  },
} as const

/** Ordered most-open to most-restrictive. Used by pickers and by policy explanations. */
export const PRIVACY_ORDER: readonly PrivacyLevel[] = ['full', 'limited', 'busy', 'hidden']

export const THEMES = ['dark', 'light'] as const
export type Theme = (typeof THEMES)[number]

/**
 * Foreground/background pairs that must meet WCAG contrast. Asserted in contrast.test.ts.
 * Anything rendered as text belongs in this list; if a pair is not here, nothing is
 * checking it.
 */
export interface ContrastPair {
  readonly name: string
  readonly foreground: string
  readonly background: string
  /** 4.5 for body text, 3.0 for large text (>=24px or >=18.66px bold) and UI borders. */
  readonly minimum: 4.5 | 3
}

const DARK = {
  surfaceBase: '#0b0d14',
  surfaceRaised: '#161a25',
  textPrimary: '#f5f6fa',
  textSecondary: '#b4b7c4', // rgba(245,246,250,0.72) composited on --surface-raised
  accent: '#6152e6',
  accentHover: '#5a4cd8',
  accentText: '#b8b0ff',
  success: '#22d3a6',
  warning: '#f5a524',
  danger: '#f4577b',
  dangerSolid: '#c8355b',
  dangerSolidHover: '#b02b4e',
} as const

const LIGHT = {
  surfaceBase: '#f5f6fa',
  surfaceRaised: '#ffffff',
  textPrimary: '#0b0d14',
  textSecondary: '#5a5d68', // rgba(11,13,20,0.68) composited on white
  accent: '#5847e0',
  accentHover: '#4a3ac9',
  accentText: '#4a3ac9',
  success: '#0f9c78',
  warning: '#a86a00',
  danger: '#c8355b',
  dangerSolid: '#c8355b',
  dangerSolidHover: '#b02b4e',
} as const

export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  { name: 'dark/body on base', foreground: DARK.textPrimary, background: DARK.surfaceBase, minimum: 4.5 },
  { name: 'dark/body on raised', foreground: DARK.textPrimary, background: DARK.surfaceRaised, minimum: 4.5 },
  { name: 'dark/secondary on raised', foreground: DARK.textSecondary, background: DARK.surfaceRaised, minimum: 4.5 },
  { name: 'dark/accent text on raised', foreground: DARK.accentText, background: DARK.surfaceRaised, minimum: 4.5 },
  { name: 'dark/accent as UI on base', foreground: DARK.accent, background: DARK.surfaceBase, minimum: 3 },
  /*
   * Text ON the accent — the filled-button case, and the gap that let a real AA failure
   * ship. The pair above checks the accent as a SHAPE against the page (3:1, correct for a
   * non-text element); nothing checked the label sitting on top of it, so white-on-#6D5CFF
   * sat at 4.20:1 on the Save button and the New event FAB until anyone thought to look.
   *
   * Hover is asserted separately because it was the worse of the two: the old dark hover
   * brightened toward white and landed at 3.40:1. A state nobody screenshots is exactly the
   * state a token test should own.
   *
   * `DARK.textPrimary` is the foreground in the light pairs too, and that is not a slip:
   * filled buttons carry white labels in BOTH themes, because the accent is dark in both.
   */
  { name: 'dark/label on accent', foreground: DARK.textPrimary, background: DARK.accent, minimum: 4.5 },
  { name: 'dark/label on accent hover', foreground: DARK.textPrimary, background: DARK.accentHover, minimum: 4.5 },
  { name: 'dark/success chip on raised', foreground: DARK.success, background: DARK.surfaceRaised, minimum: 3 },
  { name: 'dark/warning chip on raised', foreground: DARK.warning, background: DARK.surfaceRaised, minimum: 3 },
  { name: 'dark/danger chip on raised', foreground: DARK.danger, background: DARK.surfaceRaised, minimum: 3 },
  /*
   * Text ON danger — the Delete button, and the second time this exact gap has bitten.
   * The pair above checks danger as a SHAPE against the page; nothing checked the label on
   * top of it, so white-on-#F4577B sat at 2.99:1 on the one control in the app that cannot
   * be undone. Found by an axe run that finally opened a delete confirmation, not by review.
   *
   * Hover is asserted separately because brightening a red REDUCES its contrast, which is
   * the opposite of the instinct and exactly the state a user is looking at as they commit.
   */
  { name: 'dark/label on solid danger', foreground: DARK.textPrimary, background: DARK.dangerSolid, minimum: 4.5 },
  { name: 'dark/label on solid danger hover', foreground: DARK.textPrimary, background: DARK.dangerSolidHover, minimum: 4.5 },

  { name: 'light/body on base', foreground: LIGHT.textPrimary, background: LIGHT.surfaceBase, minimum: 4.5 },
  { name: 'light/body on raised', foreground: LIGHT.textPrimary, background: LIGHT.surfaceRaised, minimum: 4.5 },
  { name: 'light/secondary on raised', foreground: LIGHT.textSecondary, background: LIGHT.surfaceRaised, minimum: 4.5 },
  { name: 'light/accent text on raised', foreground: LIGHT.accentText, background: LIGHT.surfaceRaised, minimum: 4.5 },
  { name: 'light/accent as UI on base', foreground: LIGHT.accent, background: LIGHT.surfaceBase, minimum: 3 },
  { name: 'light/label on accent', foreground: DARK.textPrimary, background: LIGHT.accent, minimum: 4.5 },
  { name: 'light/label on accent hover', foreground: DARK.textPrimary, background: LIGHT.accentHover, minimum: 4.5 },
  { name: 'light/success chip on raised', foreground: LIGHT.success, background: LIGHT.surfaceRaised, minimum: 3 },
  { name: 'light/warning chip on raised', foreground: LIGHT.warning, background: LIGHT.surfaceRaised, minimum: 3 },
  { name: 'light/danger chip on raised', foreground: LIGHT.danger, background: LIGHT.surfaceRaised, minimum: 3 },
  { name: 'light/label on solid danger', foreground: DARK.textPrimary, background: LIGHT.dangerSolid, minimum: 4.5 },
  { name: 'light/label on solid danger hover', foreground: DARK.textPrimary, background: LIGHT.dangerSolidHover, minimum: 4.5 },
]

/** WCAG 2.1 relative luminance. */
export function relativeLuminance(hex: string): number {
  const value = hex.replace('#', '')
  if (value.length !== 6) throw new Error(`Expected 6-digit hex, received "${hex}"`)

  const channel = (offset: number): number => {
    const raw = Number.parseInt(value.slice(offset, offset + 2), 16) / 255
    return raw <= 0.03928 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4
  }

  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
}

/** WCAG 2.1 contrast ratio, 1–21. */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground)
  const b = relativeLuminance(background)
  const [lighter, darker] = a > b ? [a, b] : [b, a]
  return (lighter + 0.05) / (darker + 0.05)
}
