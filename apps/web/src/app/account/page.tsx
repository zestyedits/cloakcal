import { redirect } from 'next/navigation'
import { ChangePassword } from '@/components/change-password'
import { ReissueRecoveryPhrase } from '@/components/reissue-recovery-phrase'
import { supabaseServer } from '@/lib/supabase/server'
import { ThemeToggle } from '@/components/theme-toggle'
import styles from '@/components/auth.module.css'

export const metadata = { title: 'Account — CloakCal' }

/**
 * Never prerendered. This page reads the signed-in user, so a static copy would be either
 * wrong or somebody else's.
 *
 * It was dynamic anyway on any machine with `apps/web/.env.local` — `supabaseServer()`
 * reaches `cookies()`, which opts the route out of static generation. That is an accident of
 * configuration, not a property of the page: CI builds with no Supabase variables, so
 * `supabaseServer()` threw its "not configured" error during prerender instead, and the
 * whole build failed on a page that should never have been prerendered in the first place.
 *
 * `/` avoids this only because it takes `searchParams`, which forces it dynamic for
 * unrelated reasons. Saying it outright is the fix; relying on a side effect is not.
 */
export const dynamic = 'force-dynamic'

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
      {/* Reachable before you have an account. Someone who prefers light should not have to
          sign up in the dark first, and this is the only chrome these pages have. */}
      <div className={styles.themeCorner}>
        <ThemeToggle />
      </div>
      <ChangePassword email={data.user.email ?? ''} />
      {/* Below the password form rather than above it. Both need the same proof of identity,
          but changing a password is the errand people come here for; re-issuing a phrase is
          the one they need and do not know exists. Putting it second keeps the common task
          first without hiding the other behind a menu. */}
      <ReissueRecoveryPhrase email={data.user.email ?? ''} />
    </main>
  )
}
