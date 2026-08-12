import { RecoverForm } from '@/components/recover-form'
import { ThemeToggle } from '@/components/theme-toggle'
import styles from '@/components/auth.module.css'

export const metadata = { title: 'Get back in — CloakCal' }

export default function RecoverPage() {
  return (
    <main id="main" className={styles.page}>
      {/* Reachable before you have an account. Someone who prefers light should not have to
          sign up in the dark first, and this is the only chrome these pages have. */}
      <div className={styles.themeCorner}>
        <ThemeToggle />
      </div>
      <RecoverForm />
    </main>
  )
}
