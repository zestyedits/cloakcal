import { CloakLockup } from '@/components/cloak-logo'
import { ButtonLink } from '@/components/ui/button'
import styles from './fallback.module.css'

/**
 * 404 — a page the product genuinely does not have. One line and a way home; a lost
 * visitor needs an exit, not an essay. Note the phrasing says nothing about whether
 * anything EXISTS at the path: for a privacy product, "not found" and "not yours to see"
 * must be indistinguishable from the outside.
 */
export default function NotFound() {
  return (
    <main id="main" className={styles.page}>
      <div className={styles.card}>
        <CloakLockup size="sm" />
        <h1 className={styles.title}>There is nothing here</h1>
        <p className={styles.lede}>That page does not exist, or is not visible to you.</p>
        {/* NOT "your calendar". `/` is public and branches on the session, so this page is
            reachable by someone who has no account, and most 404s are. Naming the product
            is true in both states; naming a calendar they may not have is not. */}
        <ButtonLink variant="primary" href="/">
          Back to CloakCal
        </ButtonLink>
      </div>
    </main>
  )
}
