import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { NONCE_HEADER, SECURITY_HEADERS, buildCsp, createNonce } from '../src/lib/csp'

/**
 * The Content-Security-Policy, asserted where it can actually be checked.
 *
 * WHY THIS FILE EXISTS RATHER THAN LEANING ON THE E2E SPEC. Playwright runs `next dev`, so
 * every header the browser suite ever sees is the DEVELOPMENT policy — which deliberately
 * carries `'unsafe-eval'` for React Refresh and opens a websocket for HMR. Asserting only
 * there would mean the strict policy, the one that actually ships, was never tested at all.
 * `buildCsp` is a pure function precisely so the production string can be read directly.
 *
 * The other half of this file is ORDER. The policy has to be applied above middleware's
 * dev-unlock early return, or it is absent in dev and absent under Playwright — present only
 * in the one environment nothing runs in. That is the /opengraph-image bug's exact shape, and
 * a comment did not stop it the first time.
 */

const SUPABASE = 'https://bnjbgjzbddypqtoolunz.supabase.co'

const prod = buildCsp('TESTNONCE', { dev: false, supabaseUrl: SUPABASE })
const dev = buildCsp('TESTNONCE', { dev: true, supabaseUrl: SUPABASE })

/** One directive out of a policy string. */
const directive = (policy: string, name: string): string =>
  policy
    .split(';')
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `)) ?? ''

describe('the production policy', () => {
  it('nonces scripts and refuses to trust the origin wholesale', () => {
    const scriptSrc = directive(prod, 'script-src')
    expect(scriptSrc).toContain("'nonce-TESTNONCE'")
    // Without strict-dynamic, `'self'` trusts every path on this origin and any endpoint
    // that reflects input into a .js response becomes a bypass of the whole policy.
    expect(scriptSrc).toContain("'strict-dynamic'")
  })

  it('never allows eval or inline script', () => {
    // THE assertion. `'unsafe-inline'` in script-src makes the nonce decorative, and
    // `'unsafe-eval'` hands an attacker a compiler. The tempting way to fix a page broken by
    // CSP is to add one of these; this is what fails when someone does.
    const scriptSrc = directive(prod, 'script-src')
    expect(scriptSrc).not.toContain("'unsafe-eval'")
    expect(scriptSrc).not.toContain("'unsafe-inline'")
    expect(prod).not.toContain("'unsafe-eval'")
  })

  it('names the Supabase origin, without which every real account breaks', () => {
    // The single most likely thing to go wrong, and the one no test in this repo can catch
    // at runtime: the fixture never calls Supabase, so the whole e2e suite passes against a
    // policy that would break every signed-in user. Pinned here because here is the only
    // place it can be.
    const connect = directive(prod, 'connect-src')
    expect(connect).toContain(SUPABASE)
    expect(connect).toContain('wss://bnjbgjzbddypqtoolunz.supabase.co')
    // No websocket wildcard in production; that is a dev affordance for HMR.
    expect(connect).not.toMatch(/\bwss:(?!\/)/)
    expect(connect).not.toMatch(/\bws:/)
  })

  it('degrades to self when there is no Supabase URL, rather than emitting a broken directive', () => {
    // CI builds with no Supabase variables at all. A malformed or absent origin must not
    // produce `connect-src 'self' undefined`, which browsers disagree about parsing.
    for (const bad of [undefined, '', 'not a url']) {
      const connect = directive(buildCsp('N', { dev: false, supabaseUrl: bad }), 'connect-src')
      expect(connect).toBe("connect-src 'self'")
    }
  })

  it('closes the framing, base and form vectors', () => {
    expect(directive(prod, 'frame-ancestors')).toBe("frame-ancestors 'none'")
    expect(directive(prod, 'object-src')).toBe("object-src 'none'")
    // An injected <base> silently repoints every relative script URL.
    expect(directive(prod, 'base-uri')).toBe("base-uri 'self'")
    // A form that POSTs a password to another origin, which is what the auth pages are.
    expect(directive(prod, 'form-action')).toBe("form-action 'self'")
  })

  it('admits the style concession explicitly, and only for style', () => {
    // Next inlines critical CSS and next/font emits an inline <style>; neither is nonce-able.
    // Asserted rather than left implicit so the trade is visible and cannot quietly spread.
    expect(directive(prod, 'style-src')).toContain("'unsafe-inline'")
    expect(directive(prod, 'script-src')).not.toContain("'unsafe-inline'")
  })

  it('upgrades insecure requests in production but not in dev', () => {
    expect(prod).toContain('upgrade-insecure-requests')
    // It would rewrite http://localhost and make the dev server unreachable.
    expect(dev).not.toContain('upgrade-insecure-requests')
  })
})

describe('the development policy', () => {
  it('is looser in exactly two named ways, and no others', () => {
    // If dev ever diverges further, the e2e suite is testing something further from what
    // ships. Diffing the two directives keeps that divergence deliberate.
    expect(directive(dev, 'script-src')).toContain("'unsafe-eval'")
    expect(directive(dev, 'connect-src')).toContain('ws:')

    const names = (policy: string) =>
      policy.split(';').map((p) => p.trim().split(' ')[0]).filter(Boolean).sort()
    // Same directives, different contents — no directive present in one and missing from the
    // other except upgrade-insecure-requests, which is asserted above.
    expect(names(dev)).toEqual(names(prod).filter((n) => n !== 'upgrade-insecure-requests'))
  })
})

describe('the nonce', () => {
  it('is 128 bits of randomness, and never repeats', () => {
    const seen = new Set(Array.from({ length: 200 }, () => createNonce()))
    expect(seen.size).toBe(200)
    // 16 bytes base64 — a nonce short enough to guess is not a nonce.
    expect(atob([...seen][0]!).length).toBe(16)
  })
})

describe('middleware applies it before anything can return early', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/middleware.ts', import.meta.url)),
    'utf8',
  )

  it('sets the policy above the dev-unlock branch', () => {
    // The order IS the guarantee. Every Playwright project runs with the dev flag set, so a
    // policy applied after this branch is one no test and no browser pass ever sees.
    // Anchored on the BRANCH, not on a mention of the flag: the comment above buildCsp names
    // the flag too, and matching that made this assertion compare a comment against the code
    // it describes. It passed the wrong way round on the first run and said so.
    const cspAt = source.indexOf('buildCsp(')
    const devUnlockAt = source.indexOf("process.env.NEXT_PUBLIC_CLOAKCAL_DEV_UNLOCK === '1'")
    expect(cspAt).toBeGreaterThan(-1)
    expect(devUnlockAt).toBeGreaterThan(-1)
    expect(cspAt).toBeLessThan(devUnlockAt)
  })

  it('routes every response through the header helper', () => {
    // A `return NextResponse.` that is not wrapped is a response with no policy on it. The
    // redirects are the easy ones to forget, and a signed-out user hitting /settings gets
    // one of them.
    const bare = [...source.matchAll(/return (NextResponse\.\w+\()/g)]
    expect(bare.map((m) => m[0])).toEqual([])
    expect(source).toContain('withSecurity(NextResponse.redirect(redirect))')
  })

  it('rebuilds the response from the nonce-carrying headers on a token refresh', () => {
    // `setAll` fires when Supabase rotates the access token, which is roughly hourly. Passing
    // the ORIGINAL request there would drop the nonce for that one navigation — an
    // intermittent blank page nobody could reproduce on demand.
    const setAll = source.slice(source.indexOf('setAll:'), source.indexOf('const { data }'))
    expect(setAll).toContain('headers: requestHeaders')
    expect(setAll).toContain('withSecurity(')
  })

  it('hands the nonce to the layout under the header the layout reads', () => {
    expect(NONCE_HEADER).toBe('x-nonce')
    expect(source).toContain('requestHeaders.set(NONCE_HEADER, nonce)')

    const layout = readFileSync(
      fileURLToPath(new URL('../src/app/layout.tsx', import.meta.url)),
      'utf8',
    )
    expect(layout).toContain('NONCE_HEADER')
    // The theme bootstrap is the only inline script in the app and the only thing that must
    // carry the nonce. Without it the page paints the wrong theme and snaps — a full-screen
    // flash that looks like a rendering bug rather than a blocked script.
    expect(layout).toContain('<script nonce={nonce}')
  })
})

describe('the headers beside it', () => {
  it('sets nosniff, a referrer policy and a permissions policy', () => {
    const names = SECURITY_HEADERS.map(([name]) => name)
    expect(names).toContain('X-Content-Type-Options')
    expect(names).toContain('Referrer-Policy')
    expect(names).toContain('Permissions-Policy')
  })

  it('omits the two that are actively wrong to send', () => {
    const names = SECURITY_HEADERS.map(([name]) => name)
    // Deprecated, and its legacy filter introduced vulnerabilities of its own.
    expect(names).not.toContain('X-XSS-Protection')
    // Superseded by frame-ancestors in every browser this app supports.
    expect(names).not.toContain('X-Frame-Options')
  })

  it('does not leak a calendar URL to another origin', () => {
    // `?as=` carries audience ids today and booking tokens later.
    const referrer = SECURITY_HEADERS.find(([name]) => name === 'Referrer-Policy')?.[1]
    expect(referrer).toBe('strict-origin-when-cross-origin')
  })
})
