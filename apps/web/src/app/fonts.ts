import localFont from 'next/font/local'

/**
 * Inter, self-hosted.
 *
 * The Visual Guide names Inter and `packages/ui/src/tokens.css` has declared it since M0 —
 * but nothing ever LOADED it, so every screen has silently been rendering in the platform UI
 * font. A font family named in a token and absent from the page is the kind of gap that
 * looks fine in every screenshot taken on a Mac.
 *
 * SELF-HOSTED, NOT `next/font/google`. The Google loader fetches at build time, and the
 * Playwright suite spins up its own dev server; a font fetch that times out on a slow network
 * would surface as a flaky test rather than as a network problem. A committed file makes the
 * build hermetic. Pinned to the v4.1 tag rather than a branch, and the checksum is recorded
 * in docs/brand.md so the file can be re-verified rather than merely re-downloaded.
 *
 * One variable file covers the whole 100-900 range, so `weight` is a RANGE string. Passing a
 * single weight here would make Next synthesise the others.
 *
 * No italic. The app renders none, and the italic face is another 388KB.
 */
export const inter = localFont({
  src: './fonts/InterVariable.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  variable: '--font-inter',
  preload: true,
  // Metric-matched fallback, so the swap from Arial to Inter does not shift the layout.
  adjustFontFallback: 'Arial',
})

/*
 * The Dial's two faces, self-hosted under the same discipline as Inter: committed latin
 * subsets, no network fetch at build time, checksums in docs/brand.md. Both SIL OFL 1.1
 * (self-hosting explicitly permitted, no UI attribution required), vendored as the Google
 * Fonts latin subsets — Marcellus v14, DM Mono v16.
 *
 * These are identity, not accent: --font-display and --font-numeral in tokens.css resolve
 * to them on every screen, so both PRELOAD. At 14KB and 2x9KB the three files together
 * cost less than a tenth of the Inter variable file.
 */

/**
 * Marcellus — the engraved Roman of watch casebacks and bank facades. The display face
 * for headings, file tabs and caps labels.
 *
 * ONE WEIGHT, and that is the identity, not a shortcoming: engraving has no bold. Every
 * rule that uses --font-display must also set `font-weight: var(--weight-regular)` and
 * earn its emphasis from letterspacing — leaving a semibold in place would make the
 * browser synthesise a fake bold and the letterforms turn to mud.
 */
export const marcellus = localFont({
  src: './fonts/Marcellus-Regular-latin.woff2',
  weight: '400',
  style: 'normal',
  display: 'swap',
  variable: '--font-marcellus',
  preload: true,
  // Metric-matched serif fallback, so the swap does not shift heading layout.
  adjustFontFallback: 'Times New Roman',
})

/**
 * DM Mono — the numeral face. A monospace is tabular BY CONSTRUCTION, so times align in
 * any column without begging the font for a tnum feature a subset may not carry. 400 for
 * running numerals, 500 where a time is the row's jewelry.
 *
 * `adjustFontFallback: false` deliberately: the only options are Arial and Times metrics,
 * and forcing proportional metrics onto a monospace fallback would misalign the very
 * columns the face exists to keep straight.
 */
export const dmMono = localFont({
  src: [
    { path: './fonts/DMMono-Regular-latin.woff2', weight: '400' },
    { path: './fonts/DMMono-Medium-latin.woff2', weight: '500' },
  ],
  style: 'normal',
  display: 'swap',
  variable: '--font-dm-mono',
  preload: true,
  adjustFontFallback: false,
})
