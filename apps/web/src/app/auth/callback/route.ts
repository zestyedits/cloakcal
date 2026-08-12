import { NextResponse, type NextRequest } from 'next/server'
import { supabaseServer } from '@/lib/supabase/server'

/**
 * Where an emailed link lands.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS FIXES: CONFIRMING YOUR EMAIL SILENTLY DID NOTHING
 * ---------------------------------------------------------------------------
 *
 * `signUp` never passed `emailRedirectTo`, so the confirmation link used Supabase's Site URL
 * and landed on `/`. But `/` is not a public path, and middleware runs on the SERVER, before
 * any JavaScript. It saw no session cookie — there could not be one yet, the code in the URL
 * is what would create it — and redirected to `/sign-in`.
 *
 * The user reads that as "clicking confirm does nothing". Worse, the token is single-use and
 * GoTrue has already spent it by the time of the redirect, so the link cannot be retried. The
 * account stays unconfirmed and the only way forward is to request another one.
 *
 * Making `/` public would be the wrong fix twice over: it is the calendar, and it would only
 * move the race rather than remove it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE EXCHANGE HAPPENS HERE AND NOT IN THE BROWSER
 * ---------------------------------------------------------------------------
 *
 * `/recover` gets away with a client-side exchange because it is in PUBLIC_PATHS, so
 * middleware lets the request through and the browser client redeems the code on load. That
 * works, and it depends on a `code_verifier` sitting in THIS browser's storage — which is why
 * a reset link opened on a different device cannot complete.
 *
 * A Route Handler has no such constraint and can write cookies, so the session exists before
 * anything renders. One redirect, no flash of the wrong screen, and no dependence on which
 * device opened the mail.
 *
 * This route is in PUBLIC_PATHS. It has to be: its entire job is to run for someone who does
 * not have a session yet.
 */

/** Never cached, never prerendered. It reads a one-time code out of the query string. */
export const dynamic = 'force-dynamic'

/**
 * PKCE binds the exchange to the browser that started it, so a link opened somewhere else
 * cannot complete. That is the mechanism working, not a fault, but it needs saying in words
 * a person can act on.
 */
type AuthFailure = 'link_dead' | 'wrong_browser'

const fail = (url: URL, reason: AuthFailure): NextResponse =>
  NextResponse.redirect(new URL(`/sign-in?authError=${reason}`, url))

export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')

  // GoTrue reports a dead link in the query for this flow — expired, already used, or a
  // token that was tampered with. Pass the reason on rather than dumping the user at a
  // sign-in form with no explanation of why the thing they just clicked did nothing.
  const error = url.searchParams.get('error_description') ?? url.searchParams.get('error')
  if (error !== null) return fail(url, 'link_dead')

  if (code === null) {
    return NextResponse.redirect(new URL('/sign-in', url))
  }

  const supabase = await supabaseServer()
  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)

  if (exchangeError !== null) {
    // A SLUG, never the raw message.
    //
    // Supabase's text here is written for whoever is building the app: the verifier failure
    // reads "PKCE code verifier not found in storage... For SSR frameworks (Next.js,
    // SvelteKit, etc.), use @supabase/ssr on both the server and client". Putting that in
    // front of someone who clicked a link in their email is worse than saying nothing. It is
    // also the prose-as-interface mistake migration 0012 removed from the RPC path.
    const wrongBrowser = /code verifier/i.test(exchangeError.message)
    return fail(url, wrongBrowser ? 'wrong_browser' : 'link_dead')
  }

  // `next` lets one route serve both confirmation and any future emailed link, without the
  // caller having to know this route exists. Only same-origin paths are honoured: an
  // attacker-supplied absolute URL here would turn a trusted CloakCal link into an open
  // redirect, which is exactly the shape of a convincing phishing hop.
  const next = url.searchParams.get('next')
  const destination = next !== null && next.startsWith('/') && !next.startsWith('//') ? next : '/'

  return NextResponse.redirect(new URL(destination, url))
}
