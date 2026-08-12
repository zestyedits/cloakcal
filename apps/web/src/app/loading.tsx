import styles from './loading.module.css'

/**
 * Route-level loading state for the calendar fetch: a skeleton, not a spinner. A spinner
 * says "wait"; a skeleton says "here is where your week goes", and the settle from shapes
 * to content is calmer than a jump from a centred throbber.
 *
 * `aria-busy` on a quiet region — screen readers get the one useful fact (loading) once,
 * instead of a live region narrating shimmer.
 */
export default function Loading() {
  return (
    <div className={styles.main} aria-busy="true" aria-label="Loading your calendar">
      <div className={`${styles.bar} ${styles.pulse}`} />
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className={`${styles.row} ${styles.pulse}`}>
          <div className={styles.time} />
          <div className={styles.line} />
          <div className={styles.chip} />
        </div>
      ))}
    </div>
  )
}
