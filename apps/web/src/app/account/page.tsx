import { redirect } from 'next/navigation'
import { ChangePassword } from '@/components/change-password'
import { supabaseServer } from '@/lib/supabase/server'
import styles from '@/components/auth.module.css'

export const metadata = { title: 'Account — CloakCal' }

/**
 * The email is resolved here rather than in the client component because it is the KDF
 * salt: derive against the wrong address and the wrap will not open, with no useful error.
 * Taking it from the verified session removes the chance of a typo mattering.
 */
export default async function AccountPage() {
  const supabase = await supabaseServer()
  const { data } = await supabase.auth.getUser()
  // Middleware already guards this, but a Server Component must not assume middleware ran.
  if (data.user === null) redirect('/sign-in')

  return (
    <main id="main" className={styles.page}>
      <ChangePassword email={data.user.email ?? ''} />
    </main>
  )
}
