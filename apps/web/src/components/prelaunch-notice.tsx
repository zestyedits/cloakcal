import Link from 'next/link'
import { CloakHomeLink } from './cloak-logo'
import styles from './auth.module.css'

/**
 * What `/sign-up` shows while sign-ups are closed.
 *
 * A server component with no form, rather than a disabled form or a banner over a working
 * one: a Create account button that looks alive and then refuses is worse than no button,
 * and a notice above a usable form is decoration. The page states the situation and
 * offers the two things that still work, signing in and going back.
 *
 * Deliberately no waitlist field. Collecting addresses to prove we are not collecting
 * anything would be a strange first act for this product, and it would need somewhere to
 * store them that does not exist yet.
 */
export function PrelaunchNotice() {
  return (
    <div className={styles.card}>
      <CloakHomeLink />

      <h1 className={styles.title}>Not open yet</h1>
      <p className={styles.lede}>
        CloakCal is still being built. New accounts are closed for now, and the calendar is
        not ready for anyone to keep real plans in. That will change before long.
      </p>

      <p className={styles.notice}>
        Nothing is wrong on your end. There is simply no sign-up to hand you today.
      </p>

      <p className={styles.switch}>
        Already have an account? <Link href="/sign-in">Sign in</Link>
        <br />
        <Link href="/">Back to the front page</Link>
      </p>
    </div>
  )
}
