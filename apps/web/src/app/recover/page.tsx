import { RecoverForm } from '@/components/recover-form'
import styles from '@/components/auth.module.css'

export const metadata = { title: 'Get back in — CloakCal' }

export default function RecoverPage() {
  return (
    <main id="main" className={styles.page}>
      <RecoverForm />
    </main>
  )
}
