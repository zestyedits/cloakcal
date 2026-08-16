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
  textTertiaryOnRaised: '#868890', // rgba(245,246,250,0.5) over #161a25
  textTertiaryOnSunken: '#7e8085', // rgba(245,246,250,0.5) over #070910
  statusSuccessText: '#22d3a6',
  /* Ink on --surface-sunken (#070910), the sunken track. Composited, not the raw alpha. */
  textPrimaryOnSunken: '#f5f6fa',
  textSecondaryOnSunken: '#b2b4b8', // rgba(245,246,250,0.72) over #070910
  surfaceSunken: '#070910',
  /* The filled form field. Ink composited over --field-bg, not over a surface: a field is
   * its own ground, and checking its label against the card behind it measures a pairing
   * that never appears on screen. */
  fieldBg: '#10131d',
  textPrimaryOnField: '#f5f6fa',
  textSecondaryOnField: '#b5b6bc', // rgba(245,246,250,0.72) over #10131d
  /* The PLACEHOLDER, which is text and owes 4.5 like any other text. Tertiary is what a
   * placeholder normally borrows and it is the ink this project has already dimmed into
   * an AA failure twice. */
  textTertiaryOnField: '#83858c', // rgba(245,246,250,0.5) over #10131d
  fieldBorder: '#60626a', // rgba(245,246,250,0.35) over #10131d
  focusRing: '#b8b0ff',
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
  /* The same index, quieter. See tokens.css: a token rather than opacity over numeralInk,
   * because that composited to 3.46:1 in the light theme on the settings rail. */
  numeralInkQuiet: '#928b78',
  /* The plan badge's two materials, as OPAQUE hexes rather than composited alphas, unlike
   * every privacy chip above. A chip only ever sits on --surface-raised, so one composite
   * per ink is the whole check. This badge renders on --surface-base (the sidebar account
   * row), --surface-raised (the settings plate) and --surface-sunken (the price cards),
   * and it sits under --surface-overlay for as long as a pointer rests on the account row.
   * An alpha wash would need all four composited and pinned, and the hover is a state
   * nothing screenshots and axe never scans. Opaque costs one pair per plan per theme and
   * cannot be changed by a state no test looks at.
   *
   * NOT the privacy inks; tokens.css states that argument in full. */
  planFreeInk: '#b4b7c4',
  planFreeQuiet: '#1c2130',
  planProInk: '#cdc3a5',
  planProQuiet: '#2b2c30',
} as const

const LIGHT = {
  surfaceBase: '#f5f6fa',
  surfaceRaised: '#ffffff',
  textPrimary: '#0b0d14',
  textSecondary: '#5a5d68', // rgba(11,13,20,0.68) composited on white
  /* Ink on --surface-sunken (#e9ebf2). */
  textPrimaryOnSunken: '#0b0d14',
  textSecondaryOnSunken: '#52545b', // rgba(11,13,20,0.68) over #e9ebf2
  /* Tertiary at 0.60, up from 0.48 which failed AA on all three grounds. See tokens.css. */
  textTertiaryOnBase: '#696a70', // rgba(11,13,20,0.60) over #f5f6fa
  textTertiaryOnRaised: '#6d6e72', // rgba(11,13,20,0.60) over #ffffff
  textTertiaryOnSunken: '#64666d', // rgba(11,13,20,0.60) over #e9ebf2
  /* Success as TEXT. The shape colour (#0f9c78) is 3.47:1 and fails as a 12px label. */
  statusSuccessText: '#0a7357',
  surfaceSunken: '#e9ebf2',
  /* The filled form field. See the dark block for why these are composited over the field
   * rather than over a surface. */
  fieldBg: '#f2f4f9',
  textPrimaryOnField: '#0b0d14',
  textSecondaryOnField: '#55575d', // rgba(11,13,20,0.68) over #f2f4f9
  textTertiaryOnField: '#676970', // rgba(11,13,20,0.60) over #f2f4f9
  fieldBorder: '#8a8c92', // rgba(11,13,20,0.45) over #f2f4f9
  focusRing: '#4a3ac9',
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
  numeralInkQuiet: '#756340',
  /* The light plan badge. Same reasoning as the dark block above. */
  planFreeInk: '#5a5d68',
  planFreeQuiet: '#e6e8f0',
  planProInk: '#5c4d2a',
  planProQuiet: '#eae6dc',
} as const

export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  /*
   * --surface-sunken, and this was a LIVE GAP rather than a new cost. The calendar
   * header's segmented view control has put --text-secondary on the sunken track since
   * the Dial pass and nothing here checked it; the settings rail now does the same. Both
   * inks are alpha, so these are composited against the real ground hex by hex, the same
   * way the privacy chips are.
   */
  { name: 'dark/body on sunken', foreground: DARK.textPrimaryOnSunken, background: DARK.surfaceSunken, minimum: 4.5 },
  { name: 'dark/secondary on sunken', foreground: DARK.textSecondaryOnSunken, background: DARK.surfaceSunken, minimum: 4.5 },
  { name: 'dark/numeral ink on sunken', foreground: DARK.numeralInk, background: DARK.surfaceSunken, minimum: 4.5 },
  { name: 'light/body on sunken', foreground: LIGHT.textPrimaryOnSunken, background: LIGHT.surfaceSunken, minimum: 4.5 },
  { name: 'light/secondary on sunken', foreground: LIGHT.textSecondaryOnSunken, background: LIGHT.surfaceSunken, minimum: 4.5 },
  { name: 'light/numeral ink on sunken', foreground: LIGHT.numeralInk, background: LIGHT.surfaceSunken, minimum: 4.5 },

  /*
   * The filled form field, new in the control pass.
   *
   * Four pairs per theme, and the two that matter are the last two. The PLACEHOLDER is
   * text and owes 4.5, which is the pair that stops the usual mistake of reaching for
   * tertiary ink — this project has already dimmed into an AA failure twice that way. The
   * BORDER owes 3:1 because it is the boundary that identifies the control (WCAG 1.4.11),
   * and it is measured against the field's own fill rather than against the page: the
   * intended borderless design is not reachable on this palette, since a fill 3:1 above
   * --surface-base lands near #5a5d65 and reads as a disabled slab. The border does the
   * identifying, so the border is what gets held to the number.
   *
   * The FOCUS RING is checked here too, and it was checked nowhere before. globals.css has
   * shipped a global :focus-visible outline since launch and no pair ever measured it
   * against anything — which was survivable while every field was transparent and the ring
   * sat on a page ground already pinned, and stops being survivable the moment fields get
   * a ground of their own.
   */
  { name: 'dark/body on field', foreground: DARK.textPrimaryOnField, background: DARK.fieldBg, minimum: 4.5 },
  { name: 'dark/secondary on field', foreground: DARK.textSecondaryOnField, background: DARK.fieldBg, minimum: 4.5 },
  { name: 'dark/placeholder on field', foreground: DARK.textTertiaryOnField, background: DARK.fieldBg, minimum: 4.5 },
  { name: 'dark/field border on field', foreground: DARK.fieldBorder, background: DARK.fieldBg, minimum: 3 },
  { name: 'dark/focus ring on field', foreground: DARK.focusRing, background: DARK.fieldBg, minimum: 3 },
  { name: 'light/body on field', foreground: LIGHT.textPrimaryOnField, background: LIGHT.fieldBg, minimum: 4.5 },
  { name: 'light/secondary on field', foreground: LIGHT.textSecondaryOnField, background: LIGHT.fieldBg, minimum: 4.5 },
  { name: 'light/placeholder on field', foreground: LIGHT.textTertiaryOnField, background: LIGHT.fieldBg, minimum: 4.5 },
  { name: 'light/field border on field', foreground: LIGHT.fieldBorder, background: LIGHT.fieldBg, minimum: 3 },
  { name: 'light/focus ring on field', foreground: LIGHT.focusRing, background: LIGHT.fieldBg, minimum: 3 },
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
  /*
   * `accent as UI on base` carries more than buttons now: it is the ONLY thing holding
   * today's bezel (--ring-today), where an unfilled 2px ring is the whole mark and the
   * date inside renders in ordinary ink. That is also why --ring-today-ground pins the
   * ring to --surface-base — on --surface-overlay the dark accent is 2.95:1. Do not
   * relax this pair to 3 > x without moving the bezel first.
   */
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

  /*
   * The plan badge, held at 4.5 rather than 3, because the WORD is the entire content: the
   * badge renders no icon and its wash carries no meaning, so the label is the only thing
   * that has to be read. The twice-shipped "checked as a shape, not as text" lesson runs
   * the other way round here — the wash is the decorative half, held to nothing, exactly as
   * --engrave-hairline is, and the text is the half that gets pinned.
   *
   * One pair per plan per theme, and no pair against a surface, which is what the opaque
   * washes in DARK/LIGHT above buy: the badge's ground is its own wash on every surface it
   * appears on and under the account row's hover.
   */
  /*
   * The quiet index, on all three grounds. It is drawn on --surface-sunken today (the
   * settings rail) and the other two are pinned because a token invites reuse.
   *
   * THIS EXISTS BECAUSE OF A LIVE AA FAILURE, found by the first axe run in this repo
   * against a non-default theme. `.navIndex` was --numeral-ink at opacity 0.7, which is
   * 5.86:1 composited on dark sunken and 3.46:1 on light — so /settings, /settings/security
   * and the rail everywhere failed 1.4.3 in the light theme, invisibly, because every axe
   * scan here ran in dark. Second time this project has dimmed with opacity over ink that
   * barely passes; the mini month was the first.
   */
  { name: 'dark/quiet numeral ink on sunken', foreground: DARK.numeralInkQuiet, background: DARK.surfaceSunken, minimum: 4.5 },
  { name: 'dark/quiet numeral ink on base', foreground: DARK.numeralInkQuiet, background: DARK.surfaceBase, minimum: 4.5 },
  { name: 'dark/quiet numeral ink on raised', foreground: DARK.numeralInkQuiet, background: DARK.surfaceRaised, minimum: 4.5 },
  { name: 'light/quiet numeral ink on sunken', foreground: LIGHT.numeralInkQuiet, background: LIGHT.surfaceSunken, minimum: 4.5 },
  { name: 'light/quiet numeral ink on base', foreground: LIGHT.numeralInkQuiet, background: LIGHT.surfaceBase, minimum: 4.5 },
  { name: 'light/quiet numeral ink on raised', foreground: LIGHT.numeralInkQuiet, background: LIGHT.surfaceRaised, minimum: 4.5 },

  /*
   * TERTIARY INK, ON EVERY GROUND AND IN BOTH THEMES.
   *
   * Only `dark/tertiary on base` was pinned before, which is how the LIGHT theme carried a
   * failing tertiary for the life of the theme: rgba(11,13,20,0.48) is 3.41 / 3.36 / 3.31 on
   * raised / base / sunken, under AA at every size, and it was the ink on the mini month's
   * dates, the sidebar headings, the security hints and every form legend. Nothing saw it
   * because every axe run in this repo scanned dark, where the same token sits at 4.91.
   *
   * One pair per ground per theme now, so a token used on three surfaces is checked on three
   * surfaces. That is the same gap in a different coat as the shape-versus-text one below.
   */
  { name: 'dark/tertiary on raised', foreground: DARK.textTertiaryOnRaised, background: DARK.surfaceRaised, minimum: 4.5 },
  { name: 'dark/tertiary on sunken', foreground: DARK.textTertiaryOnSunken, background: DARK.surfaceSunken, minimum: 4.5 },
  { name: 'light/tertiary on base', foreground: LIGHT.textTertiaryOnBase, background: LIGHT.surfaceBase, minimum: 4.5 },
  { name: 'light/tertiary on raised', foreground: LIGHT.textTertiaryOnRaised, background: LIGHT.surfaceRaised, minimum: 4.5 },
  { name: 'light/tertiary on sunken', foreground: LIGHT.textTertiaryOnSunken, background: LIGHT.surfaceSunken, minimum: 4.5 },

  /*
   * Success as TEXT, which is a different pair from the success chip three lines up.
   * `--status-success` is held to 3 there because it is a shape; the "Free" note under an
   * agenda time is a 12px WORD, and the light value measured 3.47:1. Third time this project
   * has been caught by a colour that passed as a shape and failed as text, after the Save
   * button and the Delete button.
   */
  { name: 'dark/success as text on raised', foreground: DARK.statusSuccessText, background: DARK.surfaceRaised, minimum: 4.5 },
  { name: 'light/success as text on raised', foreground: LIGHT.statusSuccessText, background: LIGHT.surfaceRaised, minimum: 4.5 },
  { name: 'light/success as text on base', foreground: LIGHT.statusSuccessText, background: LIGHT.surfaceBase, minimum: 4.5 },

  { name: 'dark/plan free ink on its wash', foreground: DARK.planFreeInk, background: DARK.planFreeQuiet, minimum: 4.5 },
  { name: 'dark/plan pro ink on its wash', foreground: DARK.planProInk, background: DARK.planProQuiet, minimum: 4.5 },
  { name: 'light/plan free ink on its wash', foreground: LIGHT.planFreeInk, background: LIGHT.planFreeQuiet, minimum: 4.5 },
  { name: 'light/plan pro ink on its wash', foreground: LIGHT.planProInk, background: LIGHT.planProQuiet, minimum: 4.5 },

  /*
   * The annual price card's accent edge, on the sunken recess it is drawn against. A
   * graphical object at 3:1 (WCAG 1.4.11). The existing "accent as UI" pairs are against
   * base only, and a border on a DARKER ground is a different measurement — which is the
   * same gap that shipped the two label-on-fill failures, one surface over.
   */
  { name: 'dark/accent as UI on sunken', foreground: DARK.accent, background: DARK.surfaceSunken, minimum: 3 },
  { name: 'light/accent as UI on sunken', foreground: LIGHT.accent, background: LIGHT.surfaceSunken, minimum: 3 },
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
