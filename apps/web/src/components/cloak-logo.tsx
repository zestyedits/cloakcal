import Link from 'next/link'
import styles from './cloak-logo.module.css'
import { markSvg } from './cloak-mark'

/**
 * The brand lockup. The geometry itself lives in `cloak-mark.ts`, which is deliberately free
 * of JSX and of any CSS import so that `tools/render-brand-assets.ts` can import it from a
 * plain Node script and rasterise the exact same bytes the app renders.
 */

/**
 * The mark alone. Decorative by default: the lockup next to it carries the name as real
 * text, so announcing "CloakCal logo" here would make a screen reader say it twice.
 */
export function CloakMark({
  size = 32,
  variant = 'full',
  className,
}: {
  size?: number
  variant?: 'full' | 'favicon'
  className?: string | undefined
}) {
  return (
    <span
      aria-hidden="true"
      className={className === undefined ? styles.mark : `${styles.mark} ${className}`}
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: markSvg(variant, `${variant}${size}`) }}
    />
  )
}

/**
 * Mark plus wordmark. Replaces eleven lines of markup that were copy-pasted into four
 * components, with the `.mark` rule duplicated across two stylesheets.
 *
 * The wordmark stays TEXT rather than becoming part of the SVG, so it is selectable,
 * translatable, reflows, and inherits the loaded Inter rather than being frozen into a path.
 */
export function CloakLockup({
  size = 'md',
  tagline = false,
}: {
  size?: 'sm' | 'md'
  /** "YOUR TIME. YOUR BUSINESS." Off in the app shell; on where there is room to breathe. */
  tagline?: boolean
}) {
  return (
    <div className={styles.lockup} data-size={size}>
      <CloakMark size={size === 'sm' ? 28 : 32} />
      <span className={styles.text}>
        <span className={styles.wordmark}>
          Cloak<span className={styles.accent}>Cal</span>
        </span>
        {tagline && <span className={styles.tagline}>Your time. Your business.</span>}
      </span>
    </div>
  )
}

/**
 * The lockup as the door home. Every header wears this instead of a bare lockup, because a
 * logo that goes nowhere is the one affordance literally every site has taught users to
 * expect. One component rather than a Link wrapped around each call site — the lockup
 * itself exists because eleven lines of markup were once copy-pasted into four components,
 * and the wrapper would have gone the same way.
 *
 * UrlObject, not '/': typedRoutes rejects some computed string hrefs, and the object form
 * is the shape the rest of the app already uses (WeekLink). The aria-label names the
 * DESTINATION, not the image — "CloakCal home" tells a screen reader what the link does,
 * where the inner text alone would just repeat the brand.
 */
export function CloakHomeLink({ size = 'md' }: { size?: 'sm' | 'md' }) {
  return (
    <Link className={styles.homeLink} href={{ pathname: '/' }} aria-label="CloakCal home">
      <CloakLockup size={size} />
    </Link>
  )
}
