import { describe, expect, it } from 'vitest'
import {
  config,
  guardFor,
  PUBLIC_PATHS,
  SIGNED_IN_ELSEWHERE,
  WEBHOOK_PATH,
} from '../src/middleware'

/**
 * The two path lists, and the difference between them.
 *
 * This exists because of a bug that no unit test could have caught and no signed-out test
 * would ever have hit. `/recover` was public, so it looked correct — but the middleware also
 * bounced ANY signed-in user off ANY public path, and the emailed recovery link works by
 * creating a session and landing back on /recover. So the link redirected to the calendar a
 * fraction of a second before the user could type their phrase: the recovery flow was
 * unreachable in production, in exactly the situation it exists for, while appearing to work
 * in every other state.
 *
 * Found in a browser, against the live project. The lesson is the shape of the two lists —
 * "reachable without a session" and "pointless once you have one" are different questions,
 * and /recover answers them differently.
 */

/**
 * Whether the middleware runs for a path at all. Hoisted to module scope because the billing
 * blocks below ask the same question the matcher block does, and a helper that lives inside
 * one describe is a helper the next one silently cannot see.
 */
const matches = (pathname: string): boolean => {
  const pattern = config.matcher[0]
  if (pattern === undefined) throw new Error('the matcher is empty')
  return new RegExp(`^${pattern}$`).test(pathname)
}

describe('middleware path lists', () => {
  it('lets a signed-out user reach recovery', () => {
    expect(PUBLIC_PATHS).toContain('/recover')
  })

  it('serves the legal pages to people with no account', () => {
    // The whole audience for these is strangers deciding whether to trust the product, plus
    // app stores, payment processors and regulators — none of which have a session. Behind
    // the guard they would 307 to /sign-in, which is the same failure `/auth/callback` and
    // the generated `/opengraph-image` route each shipped once.
    expect(PUBLIC_PATHS).toContain('/privacy')
    expect(PUBLIC_PATHS).toContain('/terms')
  })

  it('does not bounce a signed-in user off the legal pages', () => {
    // They are public AND useful once you have an account — Settings links to both. This is
    // the /recover distinction restated: public does not imply "pointless once signed in".
    expect(SIGNED_IN_ELSEWHERE).not.toContain('/privacy')
    expect(SIGNED_IN_ELSEWHERE).not.toContain('/terms')
  })

  it('serves the landing page at the root without a session', () => {
    // `/` is the landing for a signed-out visitor and the calendar for a signed-in one;
    // page.tsx branches on the session. The prefix check appends a slash before matching,
    // so listing '/' opens exactly the root — this pins that it does NOT leak further.
    expect(PUBLIC_PATHS).toContain('/')
    const isPublic = (pathname: string) =>
      PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))
    expect(isPublic('/')).toBe(true)
    expect(isPublic('/settings')).toBe(false)
    /*
     * EVERY nested settings route, not just one. Password changes live under
     * /settings/security and the visibility defaults under /settings/privacy, and a nested
     * segment must not slip past the prefix check — a settings hub whose children were public
     * would be a privacy page reachable without a session.
     */
    for (const nested of [
      '/settings/privacy',
      '/settings/calendar',
      '/settings/security',
      '/settings/availability',
      '/settings/plan',
    ]) {
      expect(isPublic(nested), nested).toBe(false)
    }
  })

  it('does NOT bounce a signed-in user off the root', () => {
    // Signed-in users get the calendar at '/', not a redirect loop.
    expect(SIGNED_IN_ELSEWHERE).not.toContain('/')
  })

  it('does NOT bounce a signed-in user away from recovery', () => {
    // The emailed link arrives WITH a session. Bouncing it home makes the phrase untypeable.
    expect(SIGNED_IN_ELSEWHERE).not.toContain('/recover')
  })

  it('still bounces a signed-in user away from sign-in and sign-up', () => {
    expect(SIGNED_IN_ELSEWHERE).toEqual(['/sign-in', '/sign-up'])
  })

  it('bounces only from paths that are public in the first place', () => {
    // A path in the bounce list but not the public list would be unreachable in both
    // directions: redirected to sign-in when signed out, redirected home when signed in.
    for (const path of SIGNED_IN_ELSEWHERE) expect(PUBLIC_PATHS).toContain(path)
  })

  it('lets an emailed confirmation link reach the callback', () => {
    // The third time this exact shape of bug has appeared. /auth/callback exists to run for
    // someone with NO session — redeeming the code is what creates one — so a middleware that
    // guards it bounces the user to /sign-in before the exchange can happen, and GoTrue has
    // already spent the single-use token by then. "Clicking confirm does nothing", and the
    // link cannot be retried.
    expect(PUBLIC_PATHS).toContain('/auth/callback')
  })

  it('does NOT bounce a signed-in user away from the callback', () => {
    // Same reasoning as /recover. A link opened in a browser that already has a session must
    // still complete its exchange rather than being redirected home a moment too early.
    expect(SIGNED_IN_ELSEWHERE).not.toContain('/auth/callback')
  })

  it('keeps the account page private', () => {
    // It changes a password, so it must never be reachable without a session.
    expect(PUBLIC_PATHS).not.toContain('/account')
  })
})

/**
 * The matcher, and the brand assets that must survive it.
 *
 * Same class of bug as the /recover one above, in a place even harder to notice. A crawler
 * or a link-unfurl bot is never signed in, so any of these paths the matcher catches gets a
 * 307 to /sign-in — and the result is a blank browser tab and an empty Slack card, which
 * read as "nobody made a favicon" rather than as a redirect.
 *
 * It cannot be caught downstream either. `pnpm dev` and every Playwright project run with
 * NEXT_PUBLIC_CLOAKCAL_DEV_UNLOCK=1, and the middleware returns early on that flag without
 * redirecting anything. The only environment where the bug exists is production.
 *
 * This is also what pins the decision to keep the icons STATIC. A generated
 * `app/opengraph-image.tsx` serves at `/opengraph-image` with no file extension, which the
 * extension list cannot exclude — so the asset would have to be named in the matcher by hand
 * or it would 307. These tests fail if someone converts one back.
 */
describe('middleware matcher', () => {
  it.each([
    ['/icon.svg', 'the SVG favicon'],
    ['/favicon.ico', 'the ICO fallback, for Safari before 26'],
    ['/apple-icon.png', 'the iOS home-screen icon'],
    ['/opengraph-image.png', 'the social card — the one a signed-out bot fetches'],
    ['/icons/icon-192.png', 'PWA install'],
    ['/icons/icon-512-maskable.png', 'Android adaptive icon'],
    ['/manifest.webmanifest', 'without it, nothing installs'],
    ['/robots.txt', 'a crawl directive behind a login is a contradiction'],
  ])('leaves %s alone (%s)', (path) => {
    expect(matches(path)).toBe(false)
  })

  it.each(['/', '/account', '/sign-in', '/recover', '/auth/callback'])(
    'still runs middleware on %s, which PUBLIC_PATHS then lets through',
    (path) => {
      // Matching and being public are different questions. The matcher decides whether the
      // middleware runs at all; PUBLIC_PATHS decides what it does. A path excluded from the
      // matcher would skip the session refresh these routes rely on.
      expect(matches(path)).toBe(true)
    },
  )

  it.each(['/', '/account', '/sign-in', '/recover'])('still guards %s', (path) => {
    expect(matches(path)).toBe(true)
  })

  it('does not exclude a page merely because its name starts like an asset', () => {
    // The exclusions are prefix-anchored, so a real route called /icons-guide or
    // /robots-are-coming must still get a session check rather than sailing past.
    expect(matches('/icons-guide')).toBe(true)
    expect(matches('/favicon-credits')).toBe(true)
  })
})

/**
 * THE BILLING ROUTES, WHICH ARE NOT ONE QUESTION BUT THREE.
 *
 * The webhook must be reachable with no session; the other three must not be; and a signed-out
 * request to any of them must get JSON rather than a redirect. Each is a different failure and
 * each has a precedent in this file.
 */
describe('the billing routes', () => {
  /**
   * The FOURTH appearance of "a route that must run for someone with no session, guarded by
   * the thing that checks for a session". Stripe has no cookies and never will. Without this
   * entry every delivery is answered with a 307 to /sign-in, Stripe records a failure, and
   * after a few days it DISABLES the endpoint — while the app keeps looking perfect, because
   * 0024 made absence mean Free and a row that was never written is indistinguishable from a
   * free account. Dev and every Playwright project take the dev-unlock early return, so
   * nothing but this test can see it.
   */
  it('makes the webhook public, because Stripe has no session', () => {
    expect(PUBLIC_PATHS).toContain(WEBHOOK_PATH)
    expect(WEBHOOK_PATH).toBe('/api/billing/webhook')
  })

  /**
   * Public and "pointless once you have one" are different questions, and this file already
   * spends a paragraph on `/recover` for exactly this distinction. The exact-equality
   * assertion above stays green with no edit because nothing is ADDED to that list; this
   * records the reason next to the others rather than leaving it implied by an equality check
   * that reads as incidental.
   */
  it('does not bounce the webhook when a browser happens to be signed in', () => {
    expect(SIGNED_IN_ELSEWHERE).not.toContain(WEBHOOK_PATH)
  })

  /** The other three carry a session and must be refused without one. */
  it.each([
    '/api/billing/checkout',
    '/api/billing/portal',
    '/api/billing/subscription',
  ])('keeps %s behind the session guard', (path) => {
    expect(PUBLIC_PATHS).not.toContain(path)
    expect(matches(path)).toBe(true)
  })

  /** The webhook still runs middleware, which is what applies the CSP and security headers. */
  it('still runs middleware on the webhook path', () => {
    expect(matches(WEBHOOK_PATH)).toBe(true)
  })
})

describe('guardFor', () => {
  /**
   * A REDIRECT IS THE WRONG ANSWER FOR A JSON ENDPOINT, and the bug this prevents would have
   * been diagnosed as a Stripe problem. `fetch` follows a 307 while PRESERVING the method, so
   * a signed-out POST to /api/billing/checkout is re-POSTed to /sign-in, answered with 200 and
   * a page of HTML, and `res.json()` throws a parse error. The user is told something went
   * wrong when the truth is that their session expired.
   */
  it('answers an unauthenticated API request with 401 rather than a redirect', () => {
    expect(guardFor('/api/billing/checkout', false)).toBe('unauthorized')
    expect(guardFor('/api/billing/subscription', false)).toBe('unauthorized')
  })

  it('still redirects an unauthenticated PAGE request, exactly as before', () => {
    expect(guardFor('/settings', false)).toBe('to-sign-in')
    expect(guardFor('/people', false)).toBe('to-sign-in')
  })

  it('lets a public path through signed out, including the webhook', () => {
    for (const path of PUBLIC_PATHS) expect(guardFor(path, false)).toBe('allow')
  })

  it('bounces a signed-in user off the two pages that are pointless with a session', () => {
    expect(guardFor('/sign-in', true)).toBe('to-home')
    expect(guardFor('/sign-up', true)).toBe('to-home')
    // And not off /recover, which the emailed link reaches BY creating a session.
    expect(guardFor('/recover', true)).toBe('allow')
  })

  it('lets a signed-in user reach everything else', () => {
    for (const path of [
      '/',
      '/settings',
      '/settings/privacy',
      '/settings/calendar',
      '/settings/plan',
      '/api/billing/checkout',
    ]) {
      expect(guardFor(path, true)).toBe('allow')
    }
  })

  /**
   * `/apinews` is not under `/api/`. A `startsWith('/api')` check would answer 401 to a page
   * request and show a stranger a JSON body where a sign-in form belongs.
   */
  it('does not mistake a page whose name starts like the api prefix', () => {
    expect(guardFor('/apinews', false)).toBe('to-sign-in')
    expect(guardFor('/api', false)).toBe('to-sign-in')
  })
})
