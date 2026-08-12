import { describe, expect, it } from 'vitest'
import { config, PUBLIC_PATHS, SIGNED_IN_ELSEWHERE } from '../src/middleware'

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

describe('middleware path lists', () => {
  it('lets a signed-out user reach recovery', () => {
    expect(PUBLIC_PATHS).toContain('/recover')
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
  const matches = (pathname: string): boolean => {
    const pattern = config.matcher[0]
    if (pattern === undefined) throw new Error('the matcher is empty')
    return new RegExp(`^${pattern}$`).test(pathname)
  }

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
