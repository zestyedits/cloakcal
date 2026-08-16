import Link from 'next/link'
import styles from './legal-footer.module.css'

/**
 * Privacy and Terms, for the pages that have no footer of their own.
 *
 * The landing has its own footer and Settings has its roadmap card, both of which already
 * carry these links. What had nothing at all were `/sign-in`, `/sign-up` and `/recover` —
 * the three pages where a stranger is deciding whether to hand over a password, and the
 * exact moment they are most likely to want to read what they are agreeing to.
 *
 * Sign-up ALSO carries a consent line beside its button (`auth-form.tsx`), because creating
 * an account is the act of agreeing and the agreement has to be legible at that moment. This
 * footer is the standing reference, not the consent.
 *
 * A server component: two links and no state.
 */
export function LegalFooter() {
  return (
    <footer className={styles.footer}>
      <Link href="/privacy">Privacy</Link>
      <span aria-hidden="true">·</span>
      <Link href="/terms">Terms</Link>
    </footer>
  )
}
