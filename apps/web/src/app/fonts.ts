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
