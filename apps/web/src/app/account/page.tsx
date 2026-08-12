import { redirect } from 'next/navigation'

/**
 * /account grew into /settings — its two cards (password, recovery phrase) live in the
 * Security section there. The route stays as a redirect because the address has been the
 * only link out of the calendar since M1 and may be bookmarked; deleting it would turn an
 * old bookmark into a 404 that looks like a lost account.
 *
 * Still `force-dynamic`: even a redirect must not be prerendered — CI has no Supabase
 * variables and the middleware/session machinery around this path assumes request time.
 */
export const dynamic = 'force-dynamic'

export default function AccountPage() {
  redirect('/settings#security')
}
