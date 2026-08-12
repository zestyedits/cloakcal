'use client'

import { useEffect, useState } from 'react'
import styles from './offline-banner.module.css'

/**
 * The offline banner (screen-inventory 1.4's "offline / degraded" surface).
 *
 * `navigator.onLine` is a pessimistic signal — false means definitely offline, true means
 * merely "not provably offline" — which is the right shape for a banner: it never cries
 * wolf, and a request that fails while "online" still surfaces through the inline error
 * on whatever action failed.
 *
 * State starts as `online` and corrects in an effect, because the server has no idea and
 * a hydration mismatch over connectivity would be absurd. `role="status"` announces the
 * change without interrupting.
 */
export function OfflineBanner() {
  const [offline, setOffline] = useState(false)

  useEffect(() => {
    const sync = () => setOffline(!navigator.onLine)
    sync()
    window.addEventListener('online', sync)
    window.addEventListener('offline', sync)
    return () => {
      window.removeEventListener('online', sync)
      window.removeEventListener('offline', sync)
    }
  }, [])

  if (!offline) return null

  return (
    <p className={styles.banner} role="status">
      <span className={styles.dot} aria-hidden="true" />
      Offline — your calendar is read-only until you reconnect.
    </p>
  )
}
