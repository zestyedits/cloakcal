/**
 * The CloakCal mark, and the only place its geometry is written down.
 *
 * WHY THE SVG IS A STRING RATHER THAN JSX. Three things need these exact shapes: this
 * component, the static asset renderer in `tools/render-brand-assets.ts`, and the favicon
 * file it writes. A logo that exists twice drifts, and the copy nobody looks at is the one
 * that ends up in the browser tab. So `markSvg()` is the single source and everything else
 * consumes its output — React via `dangerouslySetInnerHTML`, the renderer via `fs.writeFile`.
 * There is no user input anywhere near it; the "dangerously" is about a constant we wrote.
 *
 * WHAT IT DRAWS, AND WHY IT DIVERGES FROM THE BOARD. The Visual Guide (page 1) shows a
 * soft-shaded 3D calendar tile with a cloth draped over it. Shading that survives at 96px
 * turns to mud at 16px, and the guide's own DO/DON'T list says to avoid harsh shadows and
 * keep it clean. So this is the same three ideas drawn flat: a rounded calendar tile, two
 * tabs, and a cloak sweeping the lower-right.
 *
 * The one deliberate improvement on the reference: **the dots under the cloak are absent,
 * not dimmed.** Six of nine dates are visible and three are not, which is the product drawn
 * rather than decorated. It also happens to be what survives being 16 pixels wide.
 *
 * See `docs/brand.md` for which parts are specified by the references and which are
 * extrapolated.
 */

export type MarkVariant = 'full' | 'favicon' | 'tile' | 'tile-maskable'

/* Brand ramp, literal. These are graphic fills rather than text backgrounds, so they use
 * the true brand indigo and violet — NOT the darkened `--accent`, which exists because
 * white text on #6D5CFF is 4.20:1 and fails AA. No text sits on these.
 *
 * Literal rather than `var(--brand-*)` because this string is also written to standalone
 * .svg and .png files, where no stylesheet exists to resolve a custom property. */
const VIOLET = '#7C3AED'
const INDIGO = '#6D5CFF'
const WHITE = '#F5F6FA'

/* The cloak is slate-to-charcoal, NOT the deep navy the board shows. Deep navy IS the page
 * background (`--brand-deep-navy`), so a navy cloak on a navy page read as a bite taken out
 * of the tile rather than as fabric laid over it. Caught by looking at it, which is the only
 * way this kind of thing is ever caught. */
const CLOAK_LIGHT = '#2E3350'
const CLOAK_DARK = '#151824'

/** Six visible dates. The other three are under the cloak, and are simply not drawn. */
const DOTS = [
  [9.5, 14],
  [16, 14],
  [22.5, 14],
  [9.5, 20],
  [16, 20],
  [9.5, 26],
] as const

/**
 * The cloak's leading edge, then closed around the bottom-right.
 *
 * Tuned so the curve passes cleanly BETWEEN dot positions rather than clipping through one:
 * a half-eaten dot reads as a rendering bug, not as fabric. It is clipped to the tile, so it
 * may overshoot the viewBox.
 */
const CLOAK_PATH = 'M30 11C23 16 16 21 11 30L11 32L32 32L32 11Z'

const dotsMarkup = (fill: string) =>
  `<g fill="${fill}">${DOTS.map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="1.9"/>`).join('')}</g>`

const tabsMarkup = (fill: string) =>
  `<rect x="8.8" y="3.4" width="3.6" height="5.4" rx="1.4" fill="${fill}"/>` +
  `<rect x="19.6" y="3.4" width="3.6" height="5.4" rx="1.4" fill="${fill}"/>`

const BODY = 'x="3" y="5.5" width="26" height="24" rx="6"'

const gradients = (id: string) =>
  `<linearGradient id="ccFace-${id}" x1="0" y1="0" x2="1" y2="1">` +
  `<stop offset="0" stop-color="${VIOLET}"/><stop offset="1" stop-color="${INDIGO}"/></linearGradient>` +
  `<linearGradient id="ccCloak-${id}" x1="1" y1="0" x2="0" y2="1">` +
  `<stop offset="0" stop-color="${CLOAK_LIGHT}"/><stop offset="1" stop-color="${CLOAK_DARK}"/></linearGradient>`

/**
 * The 16px drawing. Not a scaled-down `full` — a different one.
 *
 * Nine dots at 16px merge into a grey smear and the tabs become two stray pixels of noise,
 * so this drops the tabs entirely and carries three larger dots instead of six small ones.
 * Same silhouette, same cloak, same idea, legible at the size a browser tab actually
 * rasterises. Verified by rendering at 16 and magnifying, not by assuming.
 */
function faviconSvg(id: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none">` +
    `<defs>` +
    `<linearGradient id="ccFace-${id}" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${VIOLET}"/><stop offset="1" stop-color="${INDIGO}"/></linearGradient>` +
    `<linearGradient id="ccCloak-${id}" x1="1" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="${CLOAK_LIGHT}"/><stop offset="1" stop-color="${CLOAK_DARK}"/></linearGradient>` +
    `<clipPath id="ccBody-${id}"><rect x="1" y="1.5" width="14" height="13" rx="3.4"/></clipPath>` +
    `</defs>` +
    `<rect x="1" y="1.5" width="14" height="13" rx="3.4" fill="url(#ccFace-${id})"/>` +
    `<g fill="${WHITE}">` +
    `<circle cx="5.3" cy="6.4" r="1.75"/><circle cx="10.7" cy="6.4" r="1.75"/><circle cx="5.3" cy="11" r="1.75"/>` +
    `</g>` +
    `<path d="M15.5 4.6C12.2 7.2 10.2 9 7.8 15.5L7.8 16.5L16.5 16.5L16.5 4.6Z" ` +
    `fill="url(#ccCloak-${id})" clip-path="url(#ccBody-${id})"/>` +
    `</svg>`
  )
}

/**
 * A 512 app tile: the mark knocked WHITE out of a full-bleed brand square.
 *
 * The standalone mark does not work as an app icon. Launchers put it on an arbitrary
 * wallpaper, and the cloak — which is a dark shape, not an absence — stops reading as fabric
 * the moment there is no tile behind it. Here the tile supplies the frame and the cloak is
 * genuine negative space showing the brand gradient through.
 *
 * `maskable` shrinks the mark so it survives Android cropping the tile to a circle. The
 * spec's safe zone is the centred circle of 80% diameter (radius 204.8 of 512); a square
 * mark has to fit its DIAGONAL inside that, not its width, which is why the scale looks
 * over-cautious written down.
 */
function tileSvg(id: string, maskable: boolean): string {
  const scale = maskable ? 9.2 : 11
  const offset = 256 - 16 * scale
  const place = `transform="translate(${offset} ${offset}) scale(${scale})"`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">` +
    `<defs>` +
    `<linearGradient id="ccTile-${id}" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${VIOLET}"/><stop offset="1" stop-color="${INDIGO}"/></linearGradient>` +
    `<mask id="ccKnock-${id}">` +
    `<rect ${BODY} fill="#fff" ${place}/>` +
    `<g ${place}><g fill="#000">` +
    DOTS.map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="1.9"/>`).join('') +
    `<path d="${CLOAK_PATH}"/>` +
    `</g></g>` +
    `<g ${place}>${tabsMarkup('#fff')}</g>` +
    `</mask>` +
    `</defs>` +
    `<rect width="512" height="512" fill="url(#ccTile-${id})"/>` +
    `<rect width="512" height="512" fill="${WHITE}" mask="url(#ccKnock-${id})"/>` +
    `</svg>`
  )
}

/**
 * The mark as a standalone SVG document.
 *
 * `idSuffix` namespaces the gradient and clip ids. Two marks on one page sharing an id is
 * not merely invalid markup — whichever `<defs>` the browser resolves first wins for both,
 * so a favicon and a header mark on the same page would silently render as each other.
 */
export function markSvg(variant: MarkVariant, idSuffix = 'x'): string {
  const id = idSuffix.replace(/[^a-zA-Z0-9-]/g, '')
  if (variant === 'favicon') return faviconSvg(id)
  if (variant === 'tile') return tileSvg(id, false)
  if (variant === 'tile-maskable') return tileSvg(id, true)

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none">` +
    `<defs>${gradients(id)}<clipPath id="ccBody-${id}"><rect ${BODY}/></clipPath></defs>` +
    tabsMarkup(INDIGO) +
    `<rect ${BODY} fill="url(#ccFace-${id})"/>` +
    dotsMarkup(WHITE) +
    `<path d="${CLOAK_PATH}" fill="url(#ccCloak-${id})" clip-path="url(#ccBody-${id})"/>` +
    `</svg>`
  )
}
