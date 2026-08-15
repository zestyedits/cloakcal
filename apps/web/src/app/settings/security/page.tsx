import { redirect } from 'next/navigation'
import { supabaseServer } from '@/lib/supabase/server'
import { isDevFixtureEnabled } from '@/server/dev-fixture'
import { loadDevices } from '@/server/settings'
import { SecurityScreen } from '@/components/settings/security-screen'

export const metadata = { title: 'Security · CloakCal' }

/**
 * Never prerendered — reads the signed-in user. Same trap and same fix as /settings and
 * /account: CI has no Supabase variables and dies during prerender, Vercel HAS them and
 * silently bakes an empty session into static HTML. Vercel is the permissive one; a green
 * deploy there is not evidence that a page is dynamic.
 */
export const dynamic = 'force-dynamic'

/**
 * Security gets its own route, and that is a structural fix rather than a tidy-up.
 *
 * These flows used to render inside a <details> card on /settings, and they brought their
 * own page chrome with them: ChangePassword shipped a brand lockup, an <h1> and a "Back to
 * your calendar" footer, so /settings had TWO h1s and a stray logo halfway down its scroll.
 * The choice was to strip the chrome or give it a page to be the chrome of. Changing a
 * password and re-issuing a recovery phrase are errands you make a trip for, not toggles
 * you flick in passing, so they get the trip.
 */
export default async function SecurityPage() {
  const fixtureMode = isDevFixtureEnabled()

  if (fixtureMode) return <SecurityScreen demo email="" devices={[]} />

  const devicesPromise = loadDevices()
  devicesPromise.catch(() => undefined)

  const supabase = await supabaseServer()
  const { data } = await supabase.auth.getUser()
  // Middleware already guards this, but a Server Component must not assume middleware ran.
  if (data.user === null) redirect('/sign-in')

  // `demo` is passed explicitly rather than left to be inferred from the email: a user
  // whose email is null is signed in, not demoing, and the screen owes them a different
  // sentence.
  return (
    <SecurityScreen demo={false} email={data.user.email ?? ''} devices={await devicesPromise} />
  )
}
