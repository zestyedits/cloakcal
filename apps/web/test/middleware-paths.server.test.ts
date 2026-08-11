import { describe, expect, it } from 'vitest'
import { PUBLIC_PATHS, SIGNED_IN_ELSEWHERE } from '../src/middleware'

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

  it('keeps the account page private', () => {
    // It changes a password, so it must never be reachable without a session.
    expect(PUBLIC_PATHS).not.toContain('/account')
  })
})
