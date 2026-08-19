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
 * CONTACT JOINED THEM because these are also the three pages where somebody is stuck. A person
 * who cannot get past /sign-in has no route to a human anywhere else in the product: settings
 * is behind the guard they just failed, and the address was only ever printed on a page they
 * cannot reach. That was the whole gap, and it was worst exactly here.
 *
 * A server component: three links and no state.
 */
export function LegalFooter() {
  return (
    <footer className={styles.footer}>
      <Link href="/privacy">Privacy</Link>
      <span aria-hidden="true">·</span>
      <Link href="/terms">Terms</Link>
      <span aria-hidden="true">·</span>
      {/*
        `prefetch={false}`, and it is measured rather than tidy. A footer link is in the
        viewport on page load, so Next fetches the whole route for every visitor to /sign-in,
        /sign-up and /recover — to serve a page that is, by design, the one almost nobody
        opens. Under `next dev` it is worse than wasteful: the prefetch triggers a COLD COMPILE
        of a route the test never asked for, on a server eight workers share, and adding this
        link took two `page.goto` assertions elsewhere in the suite over their budget.

        Deliberately not applied to Privacy and Terms beside it. The same argument fits them,
        but changing how two links that shipped weeks ago behave is a different change from
        adding a third, and folding it in here would hide it.
      */}
      <Link href="/contact" prefetch={false}>
        Contact
      </Link>
    </footer>
  )
}
