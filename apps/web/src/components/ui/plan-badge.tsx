import { planById, type PlanId } from '@/lib/plans'
import styles from './plan-badge.module.css'

/**
 * The plan an account is on, drawn the way the privacy chip draws a level: a rectangle at
 * --radius-sm and NEVER a pill, one ink token over its own wash, the variant carried by a
 * data-attribute rather than a class per plan.
 *
 * SAME GEOMETRY, DIFFERENT MATERIAL: it does not reuse the privacy inks, and
 * `--plan-*` in tokens.css carries the full argument for why.
 *
 * NO ICON, where the privacy chip requires one. There the colour carries the state, so icon
 * and label together are what stop it being colour-alone. Here the WORD is the whole
 * content and the wash means nothing, so an icon would be decoration at 12px.
 *
 * NOT A LINK. A 12px tag cannot carry a 44px target, and in the sidebar it sits inside a row
 * that is already the door to Settings, where Plan is one row down.
 */
export function PlanBadge({
  plan,
  className,
}: {
  plan: PlanId
  className?: string | undefined
}) {
  return (
    <span
      className={className === undefined ? styles.badge : `${styles.badge} ${className}`}
      data-plan={plan}
    >
      {planById(plan).name}
      {/* Announced, never shown. "Free", read aloud straight after an email address, is not
          obviously a plan; sighted readers get that from where it sits. */}
      <span className={styles.qualifier}>&nbsp;plan</span>
    </span>
  )
}
