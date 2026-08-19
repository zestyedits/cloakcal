import { PageMasthead, PageShell } from '@/components/page-shell'
import { visibleDoors } from '@/lib/settings-sections'
import { billingEnabled } from '@/server/billing/config'
import hubStyles from '@/components/settings/settings-hub.module.css'
import styles from './loading.module.css'

/**
 * The hub's loading state — and deliberately AS MUCH of the real page as can exist without
 * data. The first version of this file was all grey bars, which read as a third, alien page
 * between the calendar and settings: a freeze, then a teleport. The chrome here is the REAL
 * chrome from the REAL components, so the navigation reads as "settings, loading its lines",
 * and the only thing that shimmers is the one part genuinely unknown — the current-state line
 * under each door.
 *
 * THE LABELS AND DESCRIPTIONS ARE NOT SHIMMERED, because they are not unknown. They are the
 * same four constants the hub renders, which means the door you are reaching for is already
 * legible and already in its final position before the data lands.
 *
 * `visibleDoors(billingEnabled())` here and in `page.tsx`, from the same function. A skeleton
 * of four rows settling to three is exactly the geometry jump this file exists to prevent.
 */
export default function SettingsLoading() {
  return (
    <PageShell back={{ href: '/', label: 'Calendar' }}>
      <PageMasthead
        title="Settings"
        lede="What is true about your account right now, and what you can change safely."
      />

      <div className={hubStyles.hub}>
        <div className={hubStyles.doors} aria-busy="true" aria-label="Loading settings">
          {visibleDoors(billingEnabled()).map((door) => (
            /* A span, not a link: a door whose current state has not arrived is still a door,
               but nothing here should look pressable before the page it belongs to is. */
            <span key={door.id} className={hubStyles.door}>
              <span className={hubStyles.doorLabel}>{door.label}</span>
              <span className={hubStyles.doorAbout}>{door.description}</span>
              <span
                className={`${styles.doorState} ${styles.pulse}`}
                aria-hidden="true"
              />
            </span>
          ))}
        </div>
      </div>
    </PageShell>
  )
}
