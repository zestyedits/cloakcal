import { PRIVACY_LEVELS, type PrivacyLevel } from '@cloakcal/ui'
import { Icon, type IconName } from './icons'
import styles from './privacy-chip.module.css'

/**
 * One privacy level, rendered the way every surface must render it: icon AND label in the
 * level's ink over its quiet wash. `PRIVACY_LEVELS` has carried these strings and icon
 * names since M0; this is the component that finally draws them.
 *
 * The `title` is the level's consequence line, so hovering a chip answers "so what?"
 * without opening anything.
 */
export function PrivacyChip({
  level,
  className,
}: {
  level: PrivacyLevel
  className?: string | undefined
}) {
  const spec = PRIVACY_LEVELS[level]
  return (
    <span
      className={className === undefined ? styles.chip : `${styles.chip} ${className}`}
      data-level={level}
      title={spec.consequence}
    >
      <Icon name={spec.icon as IconName} size={12} />
      {spec.label}
    </span>
  )
}
