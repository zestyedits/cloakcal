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
