'use client'

import { Button } from '@/components/ui/button'
import { CloakLockup } from '@/components/cloak-logo'
import styles from './fallback.module.css'

/**
 * The route error boundary — and a privacy statement, not an apology.
 *
 * `server/visibility.ts` throws ON PURPOSE when a stored rule cannot be parsed, because
 * skipping a bad rule would render the calendar MORE visible than the user asked. This
 * boundary is the other half of that contract: it says plainly that refusing was the
 * behaviour, and it must never fetch, cache, or render partial calendar data as a
 * consolation prize. A softer boundary here would quietly convert fail-closed into
 * fail-open, which is the one direction this product must never fail in.
 *
 * The digest is Next's hash of the server-side error — safe to show, useless to an
 * attacker, and the only thing a support conversation needs. The error MESSAGE is
 * deliberately not rendered: server error text is written for developers and has already
 * been through one lesson about being shown to users (the PKCE prose).
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <main id="main" className={styles.page}>
      <div className={styles.card}>
        <CloakLockup size="sm" />
        <h1 className={styles.title}>Nothing was shown</h1>
        <p className={styles.lede}>
          Something went wrong loading this page, and CloakCal refused to render it rather
          than risk showing more than you allowed. Nothing was displayed to anyone.
        </p>
        {error.digest !== undefined && (
          <p className={styles.digest}>Support code: {error.digest}</p>
        )}
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
      </div>
    </main>
  )
}
