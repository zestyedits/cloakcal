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
  /* The landing renders body copy directly on --surface-base, a pairing the app itself
   * never uses (app copy sits on raised/overlay surfaces). Composited by the same math. */
  textSecondaryOnBase: '#b3b5ba', // rgba(245,246,250,0.72) over #0b0d14
  textTertiaryOnBase: '#808287', // rgba(245,246,250,0.5) over #0b0d14
  accent: '#6152e6',
  accentHover: '#5a4cd8',
  accentText: '#b8b0ff',
  success: '#22d3a6',
  warning: '#f5a524',
  danger: '#f4577b',
  dangerSolid: '#c8355b',
  dangerSolidHover: '#b02b4e',
  /* --gradient-accent-deep stops. A gradient is checked stop by stop: the label sits on
   * every colour along the ramp, so BOTH ends must clear 4.5 under white independently —
   * a passing average with a failing end is still a failure somewhere on the button. */
  gradientDeepStart: '#6d28d9',
  gradientDeepEnd: '#6152e6',
  gradientDeepHoverStart: '#5b21b6',
  gradientDeepHoverEnd: '#5a4cd8',
  /* Privacy chip inks against their quiet washes COMPOSITED over --surface-raised —
   * the alpha wash alone has no contrast to measure. Composited by the same math as
   * textSecondary above; the alphas live in tokens.css. */
  privacyFullInk: '#4fe0bb',
  privacyFullChip: '#183437', // rgba(34,211,166,0.14) over #161a25
  privacyLimitedInk: '#b8b0ff',
  privacyLimitedChip: '#242548', // rgba(109,92,255,0.16) over #161a25
  privacyBusyInk: '#f7b64e',
  privacyBusyChip: '#3a3025', // rgba(245,165,36,0.16) over #161a25
  privacyHiddenInk: '#9aa0b5',
  privacyHiddenChip: '#1e2232', // rgba(42,47,69,0.4) over #161a25
  /* The Dial's index ink (--numeral-ink): champagne, carrying every rendered time. It
   * sits on the base surface (hour gutter), the raised plates (agenda rows, week
   * blocks, the landing demo card) and the busy block's hidden wash, so all three
   * grounds are pinned. --engrave-hairline and --minute-tick are cut from the same
   * metal but are DECORATIVE shapes and deliberately absent here: nothing may render
   * them as ink or rely on them being seen. */
  numeralInk: '#cdc3a5',
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
  privacyFullInk: '#0b7a5e',
  privacyFullChip: '#e2f3ef', // rgba(15,156,120,0.12) over #ffffff
  privacyLimitedInk: '#4a3ac9',
  privacyLimitedChip: '#eeedfc', // rgba(88,71,224,0.10) over #ffffff
  privacyBusyInk: '#8a5600',
  privacyBusyChip: '#f5ede0', // rgba(168,106,0,0.12) over #ffffff
  privacyHiddenInk: '#3f4459',
  privacyHiddenChip: '#e5e6e9', // rgba(42,47,69,0.12) over #ffffff
  /* The light Dial's index ink: the champagne engraved as a dark bronze rather than
   * applied as a gold — same hue family, dark enough to be text on paper. */
  numeralInk: '#5c4d2a',
} as const

export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  { name: 'dark/body on base', foreground: DARK.textPrimary, background: DARK.surfaceBase, minimum: 4.5 },
  { name: 'dark/body on raised', foreground: DARK.textPrimary, background: DARK.surfaceRaised, minimum: 4.5 },
  { name: 'dark/secondary on raised', foreground: DARK.textSecondary, background: DARK.surfaceRaised, minimum: 4.5 },
  { name: 'dark/accent text on raised', foreground: DARK.accentText, background: DARK.surfaceRaised, minimum: 4.5 },
  /*
   * Landing-page pairs: the marketing surface puts secondary and tertiary ink, and the
   * accent-text lavender, straight onto --surface-base. Tertiary is held to 4.5 rather
   * than 3 because the landing uses it at caption sizes, not only display numerals.
   */
  { name: 'dark/secondary on base', foreground: DARK.textSecondaryOnBase, background: DARK.surfaceBase, minimum: 4.5 },
  { name: 'dark/tertiary on base', foreground: DARK.textTertiaryOnBase, background: DARK.surfaceBase, minimum: 4.5 },
  { name: 'dark/accent text on base', foreground: DARK.accentText, background: DARK.surfaceBase, minimum: 4.5 },
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
  /*
   * The deep gradient is theme-agnostic (declared once on :root), so its pairs appear once.
   * White labels in both themes, same as the accent and the solid danger.
   */
  { name: 'gradient/label on deep start', foreground: DARK.textPrimary, background: DARK.gradientDeepStart, minimum: 4.5 },
  { name: 'gradient/label on deep end', foreground: DARK.textPrimary, background: DARK.gradientDeepEnd, minimum: 4.5 },
  { name: 'gradient/label on deep hover start', foreground: DARK.textPrimary, background: DARK.gradientDeepHoverStart, minimum: 4.5 },
  { name: 'gradient/label on deep hover end', foreground: DARK.textPrimary, background: DARK.gradientDeepHoverEnd, minimum: 4.5 },
  /*
   * Privacy chip ink on its composited wash. The raw --privacy-* colours are NOT here as
   * shapes on purpose: hidden's slate is 1.32:1 on the dark raised surface by design (a
   * hidden event should barely be there), which is exactly why nothing may render the raw
   * colour as the sole carrier — the chip always shows ink + icon + label.
   */
  /*
   * The numeral ink, on each ground a time actually renders over: the hour gutter sits
   * on base, the agenda rows and week blocks on raised, and a busy week block puts its
   * time over the hidden-quiet wash (the composited chip hex doubles as that ground).
   * Held to 4.5 because times render at --text-xs in the week grid.
   */
  { name: 'dark/numeral ink on base', foreground: DARK.numeralInk, background: DARK.surfaceBase, minimum: 4.5 },
  { name: 'dark/numeral ink on raised', foreground: DARK.numeralInk, background: DARK.surfaceRaised, minimum: 4.5 },
  { name: 'dark/numeral ink on hidden wash', foreground: DARK.numeralInk, background: DARK.privacyHiddenChip, minimum: 4.5 },
  { name: 'dark/privacy full ink on chip', foreground: DARK.privacyFullInk, background: DARK.privacyFullChip, minimum: 4.5 },
  { name: 'dark/privacy limited ink on chip', foreground: DARK.privacyLimitedInk, background: DARK.privacyLimitedChip, minimum: 4.5 },
  { name: 'dark/privacy busy ink on chip', foreground: DARK.privacyBusyInk, background: DARK.privacyBusyChip, minimum: 4.5 },
  { name: 'dark/privacy hidden ink on chip', foreground: DARK.privacyHiddenInk, background: DARK.privacyHiddenChip, minimum: 4.5 },

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
  { name: 'light/numeral ink on base', foreground: LIGHT.numeralInk, background: LIGHT.surfaceBase, minimum: 4.5 },
  { name: 'light/numeral ink on raised', foreground: LIGHT.numeralInk, background: LIGHT.surfaceRaised, minimum: 4.5 },
  { name: 'light/numeral ink on hidden wash', foreground: LIGHT.numeralInk, background: LIGHT.privacyHiddenChip, minimum: 4.5 },
  { name: 'light/privacy full ink on chip', foreground: LIGHT.privacyFullInk, background: LIGHT.privacyFullChip, minimum: 4.5 },
  { name: 'light/privacy limited ink on chip', foreground: LIGHT.privacyLimitedInk, background: LIGHT.privacyLimitedChip, minimum: 4.5 },
  { name: 'light/privacy busy ink on chip', foreground: LIGHT.privacyBusyInk, background: LIGHT.privacyBusyChip, minimum: 4.5 },
  { name: 'light/privacy hidden ink on chip', foreground: LIGHT.privacyHiddenInk, background: LIGHT.privacyHiddenChip, minimum: 4.5 },
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
