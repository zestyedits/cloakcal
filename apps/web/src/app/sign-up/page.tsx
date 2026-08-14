import { Suspense } from 'react'
import { AuthForm } from '@/components/auth-form'
import { PrelaunchNotice } from '@/components/prelaunch-notice'
import { ThemeToggle } from '@/components/theme-toggle'
import { signupsOpen } from '@/lib/signups'
import styles from '@/components/auth.module.css'

// A function rather than a constant so the title matches the page: promising "Create your
// calendar" in the tab of a page that offers no such thing is a small lie told first.
export function generateMetadata() {
  return {
    title: signupsOpen() ? 'Create your calendar · CloakCal' : 'Not open yet · CloakCal',
  }
}

export default function SignUpPage() {
  return (
    <main id="main" className={styles.page}>
      {/* Reachable before you have an account. Someone who prefers light should not have to
          sign up in the dark first, and this is the only chrome these pages have. */}
      <div className={styles.themeCorner}>
        <ThemeToggle />
      </div>
      {signupsOpen() ? (
        // AuthForm reads `?authError=` so a dead confirmation link can explain itself, and
        // useSearchParams opts a component out of static prerendering unless it sits behind
        // a boundary. Wrapping keeps the page static and defers only this subtree, rather
        // than marking the whole route dynamic to serve one query parameter.
        <Suspense fallback={null}>
          <AuthForm mode="sign-up" />
        </Suspense>
      ) : (
        <PrelaunchNotice />
      )}
    </main>
  )
}
