import { AuthForm } from '@/components/auth-form'
import styles from '@/components/auth.module.css'

export const metadata = { title: 'Sign in — CloakCal' }

export default function SignInPage() {
  return (
    <main id="main" className={styles.page}>
      <AuthForm mode="sign-in" />
    </main>
  )
}
