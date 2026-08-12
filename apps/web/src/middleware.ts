import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

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
export const PUBLIC_PATHS = ['/', '/sign-in', '/sign-up', '/recover', '/auth/callback']

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

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request })

  // Development fixture mode: there is no account to sign in to, so guarding would lock the
  // app out of its own test data. Gated identically to the dev key — NODE_ENV plus an
  // explicit flag — so a production build cannot take this branch. See server/dev-fixture.ts.
  if (
    process.env.NODE_ENV !== 'production' &&
    process.env.NEXT_PUBLIC_CLOAKCAL_DEV_UNLOCK === '1'
  ) {
    return response
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (url === undefined || key === undefined) return response

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        for (const { name, value } of toSet) request.cookies.set(name, value)
        response = NextResponse.next({ request })
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options)
      },
    },
  })

  const { data } = await supabase.auth.getClaims()
  const signedIn = data?.claims !== undefined && data.claims !== null

  const { pathname } = request.nextUrl
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))

  if (!signedIn && !isPublic) {
    const redirect = request.nextUrl.clone()
    redirect.pathname = '/sign-in'
    // The path only. Never the query string: View As audiences and future booking tokens
    // live there, and a redirect target is one of the easiest things to end up in a log.
    redirect.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname)}`
    return NextResponse.redirect(redirect)
  }

  const bouncesWhenSignedIn = SIGNED_IN_ELSEWHERE.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  )
  if (signedIn && bouncesWhenSignedIn) {
    const redirect = request.nextUrl.clone()
    redirect.pathname = '/'
    redirect.search = ''
    return NextResponse.redirect(redirect)
  }

  return response
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
