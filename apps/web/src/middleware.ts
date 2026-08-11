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

const PUBLIC_PATHS = ['/sign-in', '/sign-up', '/recover']

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

  if (signedIn && isPublic) {
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
    '/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|icons/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
