import { Suspense } from 'react'
import { AuthForm } from '@/components/auth-form'
import styles from '@/components/auth.module.css'

export const metadata = { title: 'Create your calendar — CloakCal' }

export default function SignUpPage() {
  return (
    <main id="main" className={styles.page}>
      {/* AuthForm reads `?authError=` so a dead confirmation link can explain itself, and
          useSearchParams opts a component out of static prerendering unless it sits behind a
          boundary. Wrapping keeps the page static and defers only this subtree, rather than
          marking the whole route dynamic to serve one query parameter. */}
      <Suspense fallback={null}>
        <AuthForm mode="sign-up" />
      </Suspense>
    </main>
  )
}
