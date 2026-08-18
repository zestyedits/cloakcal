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
 * EACH FAMILY SHIPS ITS OWN LICENCE, and that is an obligation rather than tidiness:
 * OFL 1.1 §2 requires the copyright notice and the licence to travel with the Font
 * Software, and subsetting to latin makes each of these a Modified Version, so the
 * requirement bites harder here, not less. `OFL.txt` in ./fonts is Inter's and names only
 * Inter's authors; `OFL-Marcellus.txt` and `OFL-DMMono.txt` carry the other two. A fourth
 * vendored face needs a fourth file — do not assume the existing one covers it.
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
 *
 * WHERE IT MAY GO, written down after an audit rather than left to taste (2026-08-18):
 *
 *   - Headings that appear ONCE per page or section. A page title, a card's name, a
 *     section kicker.
 *   - The engraved caps LABEL voice: 12-14px, uppercase, --tracking-engraved-caps*. This
 *     is a label naming a thing, never the thing itself.
 *
 * And where it may not: running copy, form controls, and any VALUE — the answer beside a
 * label, a title in a list row, anything a user reads for content rather than for
 * structure. Inter carries all of that, and carries it at every density the product has.
 *
 * The risk being managed is specific. Marcellus is a display Roman, and a display Roman
 * spread across a dense productivity surface stops reading as a calendar and starts
 * reading as an editorial or a watch advertisement. Confined to structure it does the
 * opposite: it tells you instantly which words are the furniture.
 *
 * The audit found nothing to move. All 41 declarations were already one of the two
 * permitted cases, so this comment records the rule rather than a change — which is the
 * point, because the next twenty declarations are the ones at risk.
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
 * NO BOLD, and this face now backs --font-mono as well as --font-numeral — which is a
 * NEW constraint, because --font-mono used to resolve to the platform monospace and every
 * platform monospace has a real bold. 500 is the ceiling: a `font-weight: 600` on a key
 * id, a kbd or a recovery word gets synthesised, same failure mode as Marcellus above.
 * Nothing does that today; this is here so the next person does not discover it.
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
