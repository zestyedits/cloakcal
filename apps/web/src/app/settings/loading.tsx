import styles from './loading.module.css'

/**
 * Settings-shaped skeleton. Without this, navigating here fell through to the ROOT
 * loading state — an agenda-shaped skeleton morphing into a settings page, which read as
 * a freeze followed by a teleport. Shapes match the real layout (header bar, nav chips,
 * section rows) so the page settles into content instead of jumping.
 *
 * No text, same as the calendar's skeleton: nothing for the leak scans to reason about.
 */
export default function SettingsLoading() {
  return (
    <div className={styles.page} aria-busy="true" aria-label="Loading settings">
      <div className={styles.headerBar}>
        <div className={`${styles.chip} ${styles.pulse}`} />
      </div>
      <div className={styles.body}>
        <div className={`${styles.title} ${styles.pulse}`} />
        <div className={styles.chips}>
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className={`${styles.chip} ${styles.pulse}`} />
          ))}
        </div>
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className={`${styles.section} ${styles.pulse}`} />
        ))}
      </div>
    </div>
  )
}
