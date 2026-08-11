import { AuthForm } from '@/components/auth-form'
import styles from '@/components/auth.module.css'

export const metadata = { title: 'Create your calendar — CloakCal' }

export default function SignUpPage() {
  return (
    <main id="main" className={styles.page}>
      <AuthForm mode="sign-up" />
    </main>
  )
}
