import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { NONCE_HEADER, SECURITY_HEADERS, buildCsp, createNonce } from '@/lib/csp'

/**
 * Session refresh, and the route guard.
 *
 * Supabase access tokens are short-lived. Server Components cannot write cookies, so the
 * refreshed token has to be written somewhere that can — which is here. Without it a user
 * is signed out roughly every hour with no explanation.
 *
 * `getClaims()` rather than `getSession()`: the session cookie is client-writable, so
 * trusting it server-side would let anyone hand us a forged user id. getClaims verifies the
 * JWT signature, which is the difference between reading a claim and believing one.
 *
 * This guard is coarse — signed in or not. It is NOT where privacy is decided: field
 * visibility belongs to packages/policy and row authorisation to RLS. A middleware that
 * started making content decisions would be a third place privacy could disagree with
 * itself, and D2 exists to stop exactly that.
 */

/**
 * Reachable without a session.
 *
 * `/` is here because it is the LANDING PAGE for a signed-out visitor and the calendar
 * for a signed-in one — page.tsx branches on the session. The prefix check appends a
 * slash before matching, so listing '/' makes exactly the root public, nothing else.
 */
/**
 * Named once, and used three times below: in PUBLIC_PATHS, in the early return that keeps a
 * Supabase outage from becoming a billing outage, and by the test that pins both.
 */
export const WEBHOOK_PATH = '/api/billing/webhook'

export const PUBLIC_PATHS = [
  '/',
  '/sign-in',
  '/sign-up',
  '/recover',
  '/auth/callback',
  // A legal page behind the auth guard is a legal page nobody can read, and the people most
  // likely to want these are strangers deciding whether to sign up at all. They are also what
  // an app store, a payment processor and a regulator ask for by URL — none of which have a
  // session either.
  '/privacy',
  '/terms',
  /*
   * THE FOURTH APPEARANCE OF ONE SHAPE: a route that must run for somebody with NO session,
   * guarded by the thing that checks for a session. `/auth/callback`, `/opengraph-image` and
   * `/recover` were the first three, and every one of them shipped broken.
   *
   * Stripe has no cookies and never will. Without this entry every delivery is answered with
   * a 307 to /sign-in, Stripe records a failure, and after a few days it DISABLES the
   * endpoint — while the app keeps looking perfect, because 0024 made absence mean Free and a
   * subscription row that was never written is indistinguishable from a free account.
   *
   * Nothing here would catch it either: dev and every Playwright project run with
   * NEXT_PUBLIC_CLOAKCAL_DEV_UNLOCK=1, which returns early below before any redirect happens.
   * `middleware-paths.server.test.ts` is the guard, and it also pins that the two
   * SESSION-authenticated billing routes are NOT public.
   */
  WEBHOOK_PATH,
]

/**
 * Public paths a signed-in user has no business on, and gets bounced home from.
 *
 * `/recover` is deliberately NOT here, and the distinction is the whole recovery flow. The
 * emailed link works by CREATING a session and landing back on /recover, so a blanket
 * "signed in? go home" would redirect the user away a fraction of a second before they could
 * type their phrase — the feature would be unreachable in exactly the situation it exists
 * for, while looking fine to anyone testing it signed out.
 *
 * It is also the page a signed-in user with a working password but a broken wrap needs,
 * which is precisely the state a half-applied change leaves behind.
 */
export const SIGNED_IN_ELSEWHERE = ['/sign-in', '/sign-up']

/**
 * WHAT TO DO WITH A REQUEST, as a pure function.
 *
 * Extracted for the reason `buildCsp` is a pure function: it is the only way any middleware
 * fact in this repo has ever been pinned without a server, and every Playwright project takes
 * the dev-unlock early return before this logic is reached, so a browser cannot test it either.
 *
 * `unauthorized` EXISTS BECAUSE A REDIRECT IS THE WRONG ANSWER FOR A JSON ENDPOINT, and the
 * bug it fixes would have been diagnosed as a Stripe problem. `fetch` follows a 307 while
 * PRESERVING the method, so a signed-out POST to /api/billing/checkout would be re-POSTed to
 * /sign-in, answered with 200 and a page of HTML, and the client's `res.json()` would throw a
 * parse error. The user is told something went wrong when the truth is that their session
 * expired — which is a sentence `lib/billing-error.ts` already has.
 *
 * Everything that is not under /api keeps today's behaviour byte for byte.
 */
export type Guard = 'allow' | 'to-sign-in' | 'to-home' | 'unauthorized'

const matches = (paths: readonly string[], pathname: string): boolean =>
  paths.some((p) => pathname === p || pathname.startsWith(`${p}/`))

export function guardFor(pathname: string, signedIn: boolean): Guard {
  if (!signedIn && !matches(PUBLIC_PATHS, pathname)) {
    return pathname.startsWith('/api/') ? 'unauthorized' : 'to-sign-in'
  }
  if (signedIn && matches(SIGNED_IN_ELSEWHERE, pathname)) return 'to-home'
  return 'allow'
}

export async function middleware(request: NextRequest) {
  /*
   * THE CSP IS BUILT FIRST, ABOVE THE DEV-UNLOCK RETURN, AND THAT ORDER IS THE POINT.
   *
   * Every Playwright project runs with NEXT_PUBLIC_CLOAKCAL_DEV_UNLOCK=1, which takes the
   * early return below. A policy applied after it would be a policy no test ever sees, on a
   * header whose entire job is to be present — and it would be absent in dev, so a browser
   * pass could not see it either. That is exactly the shape of the /opengraph-image bug,
   * where the one environment nothing runs in was the only one that behaved differently.
   *
   * So: nonce and headers on EVERY response this matcher catches, signed in or out, dev or
   * production. Only the policy's contents differ by environment, and buildCsp owns that.
   */
  const nonce = createNonce()
  const csp = buildCsp(nonce, {
    dev: process.env.NODE_ENV !== 'production',
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  })

  // The nonce reaches the root layout on the REQUEST, because a Server Component cannot read
  // the response it is in the middle of producing. `layout.tsx` reads it with headers().
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set(NONCE_HEADER, nonce)

  /** Every response below is built through here, so none can escape without the policy. */
  const withSecurity = (res: NextResponse): NextResponse => {
    res.headers.set('Content-Security-Policy', csp)
    for (const [name, value] of SECURITY_HEADERS) res.headers.set(name, value)
    return res
  }

  let response = withSecurity(NextResponse.next({ request: { headers: requestHeaders } }))

  // Development fixture mode: there is no account to sign in to, so guarding would lock the
  // app out of its own test data. Gated identically to the dev key — NODE_ENV plus an
  // explicit flag — so a production build cannot take this branch. See server/dev-fixture.ts.
  if (
    process.env.NODE_ENV !== 'production' &&
    process.env.NEXT_PUBLIC_CLOAKCAL_DEV_UNLOCK === '1'
  ) {
    return response
  }

  /*
   * THE WEBHOOK SKIPS THE SESSION LOOKUP ENTIRELY, and this is about blast radius rather than
   * latency. Every request the matcher catches costs a `getClaims()` round trip to Supabase,
   * including one that can never carry a session. On a Supabase outage that turns a webhook
   * into a timeout — so a Supabase outage becomes a BILLING outage, for a request that was
   * never going to consult Supabase for anything.
   *
   * The path is still in PUBLIC_PATHS below, so this is the second of two independent gates
   * for one fact. That is the shape 0024 uses deliberately: the revokes and the missing
   * policies each stop the same write, so removing either one fails loudly instead of quietly.
   */
  if (request.nextUrl.pathname === WEBHOOK_PATH) return response

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (url === undefined || key === undefined) return response

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        for (const { name, value } of toSet) request.cookies.set(name, value)
        // Rebuilt from `requestHeaders`, not `request`, or the nonce would be dropped for
        // every user whose token happened to refresh on this request — an intermittent
        // blank page on roughly one navigation an hour, which is the worst kind.
        response = withSecurity(NextResponse.next({ request: { headers: requestHeaders } }))
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options)
      },
    },
  })

  const { data } = await supabase.auth.getClaims()
  const signedIn = data?.claims !== undefined && data.claims !== null

  const { pathname } = request.nextUrl

  switch (guardFor(pathname, signedIn)) {
    case 'unauthorized':
      // JSON, not a redirect. See guardFor's header: `fetch` follows a 307 preserving the
      // method, so a redirect here surfaces to the user as a parse error rather than as
      // "you are signed out". The slug is one lib/billing-error.ts already renders.
      return withSecurity(
        NextResponse.json({ error: 'not_signed_in' }, { status: 401 }) as NextResponse,
      )

    case 'to-sign-in': {
      const redirect = request.nextUrl.clone()
      redirect.pathname = '/sign-in'
      // The path only. Never the query string: View As audiences and future booking tokens
      // live there, and a redirect target is one of the easiest things to end up in a log.
      redirect.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname)}`
      return withSecurity(NextResponse.redirect(redirect))
    }

    case 'to-home': {
      const redirect = request.nextUrl.clone()
      redirect.pathname = '/'
      redirect.search = ''
      return withSecurity(NextResponse.redirect(redirect))
    }

    case 'allow':
      return response
  }
}

export const config = {
  matcher: [
    // Everything except static assets and image optimisation, which carry no session and
    // would only add latency.
    //
    // THE BRAND ASSETS HAVE TO BE REACHABLE SIGNED OUT, and getting that wrong is silent.
    // A crawler or an unfurl bot is never signed in, so anything this matcher catches is
    // answered with a 307 to /sign-in — and an empty social card looks like a design
    // oversight rather than a redirect. Nothing in the test suite would show it either:
    // dev and Playwright both run with NEXT_PUBLIC_CLOAKCAL_DEV_UNLOCK=1, which returns
    // early above and never redirects at all.
    //
    // Two different mechanisms keep them out, and it is worth knowing which is which:
    //   - `/icon.svg`, `/apple-icon.png`, `/opengraph-image.png` and `/icons/*` fall through
    //     the extension list. They are STATIC files, which is why they have extensions to
    //     fall through with. A generated `app/opengraph-image.tsx` would serve at
    //     `/opengraph-image` with no extension and would be caught.
    //   - `/favicon.ico`, `/manifest.webmanifest` and `/robots.txt` are named outright,
    //     because `.ico`, `.webmanifest` and `.txt` are not in the extension list.
    //
    // `middleware-paths.server.test.ts` pins every one of these.
    '/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|robots.txt|icons/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
