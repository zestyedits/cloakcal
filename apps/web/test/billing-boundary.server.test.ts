import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * WHERE THE BILLING SECRETS AND THE ONE WRITE-CAPABLE DATABASE CONNECTION MAY LIVE.
 *
 * Source-level, in the house style of `auth-buttons.server.test.ts` and `plan-badge`'s
 * subscription grep, because these are all claims about the SHAPE of the codebase rather than
 * about the behaviour of a function. A comment did not stop the second button system; it will
 * not stop the second database connection either.
 *
 * The most important assertion here is the single-importer one, and the reason is that this
 * change made an existing guard BLIND. `plan-badge.server.test.ts` greps for
 * `from('subscriptions')…insert|update|upsert|delete` — a PostgREST shape — and the billing
 * writer speaks raw SQL over a direct connection, so that sweep now stays green while a write
 * path exists that it cannot see. It stays, because it still guards the client path, and this
 * file guards the other one.
 */

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

function walk(dir: string, prefix = ''): string[] {
  let found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const rel = prefix === '' ? entry : `${prefix}/${entry}`
    if (statSync(full).isDirectory()) found = found.concat(walk(full, rel))
    else if (/\.tsx?$/.test(entry)) found.push(rel)
  }
  return found
}

const FILES = walk(SRC).map((path) => ({ path, source: readFileSync(join(SRC, path), 'utf8') }))

/** Comments stripped, so a file may explain a rule without appearing to break it. */
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/**
 * Who imports a module under `server/billing/`, counting BOTH spellings.
 *
 * A sibling writes `from './db'` and everything else writes `from '@/server/billing/db'`, so a
 * pattern that only knows the second one reports zero importers and passes — which is the
 * worst possible outcome for a sweep whose whole job is to count them. The first version of
 * this file did exactly that.
 */
function importersOf(basename: string, self: string): string[] {
  const pattern = new RegExp(
    `\\bfrom\\s+['"](?:\\./${basename}|[^'"]*server/billing/${basename})['"]`,
  )
  return FILES.filter((f) => f.path !== self && pattern.test(code(f.source))).map((f) => f.path)
}

describe('the source tree this sweep reads', () => {
  it('is real, so nothing below can pass vacuously', () => {
    expect(FILES.length).toBeGreaterThan(50)
    expect(FILES.map((f) => f.path)).toContain('server/billing/db.ts')
    expect(FILES.map((f) => f.path)).toContain('app/api/billing/webhook/route.ts')
  })
})

describe('the write-capable database connection', () => {
  /**
   * ONE IMPORTER. `server/billing/db.ts` opens a connection as `billing_writer`, which is the
   * single exception ADR 0007 designed instead of a service-role key. Importing it from a page
   * would put a write-capable connection one import away from code holding a user session, and
   * would pull a Postgres driver into that route's server bundle.
   */
  it('is imported by exactly one file, and that file only by the webhook', () => {
    expect(importersOf('db', 'server/billing/db.ts')).toEqual(['server/billing/apply.ts'])
    // The chain is one deep, not merely one wide: a second hop would let a page reach the
    // connection through a module that looks harmless.
    expect(importersOf('apply', 'server/billing/apply.ts')).toEqual([
      'app/api/billing/webhook/route.ts',
    ])
  })

  /**
   * A VALUE import, not a type one. `billing-band.tsx` is `'use client'` and legitimately names
   * `BillingView` — with `import type`, which TypeScript erases, so nothing from the server
   * module reaches the bundle. That distinction is the whole reason the band can be typed
   * against the server's own shape instead of a hand-copied duplicate that drifts.
   */
  it('is never value-imported by a client module', () => {
    const offenders = FILES.filter(
      (f) =>
        f.source.trimStart().startsWith("'use client'") &&
        /^import (?!type )[^;]*\bfrom\s+['"][^'"]*billing\/(db|apply|config|request)['"]/m.test(
          code(f.source),
        ),
    ).map((f) => f.path)
    expect(offenders).toEqual([])
  })
})

describe('the billing secrets', () => {
  /**
   * These are the FIRST server-only secrets in this repo — `.env.example` used to have a
   * paragraph explaining that there deliberately were none. A `NEXT_PUBLIC_` prefix on any of
   * them would inline the value into a browser bundle, and the failure would be silent.
   */
  const SECRETS = [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'BILLING_DATABASE_URL',
    'STRIPE_PRICE_PRO_MONTHLY',
    'STRIPE_PRICE_PRO_ANNUAL',
    'STRIPE_PORTAL_CONFIGURATION_ID',
    'CLOAKCAL_BILLING',
  ]

  it('are read in exactly one module', () => {
    for (const name of SECRETS) {
      const readers = FILES.filter((f) => code(f.source).includes(name)).map((f) => f.path)
      expect(readers, `${name} is read outside the config module`).toEqual([
        'server/billing/config.ts',
      ])
    }
  })

  it('are never NEXT_PUBLIC_, which would inline them into a browser bundle', () => {
    for (const { path, source } of FILES) {
      for (const name of SECRETS) {
        expect(code(source), `${path} exposes ${name}`).not.toContain(`NEXT_PUBLIC_${name}`)
      }
    }
  })

  it('is never imported by a client module', () => {
    const offenders = FILES.filter(
      (f) => f.source.trimStart().startsWith("'use client'") && /from ['"]stripe['"]/.test(f.source),
    ).map((f) => f.path)
    expect(offenders).toEqual([])
  })
})

describe('the Stripe SDK', () => {
  /**
   * The SDK carries the secret key and would add roughly a megabyte to any bundle it reached.
   * `lib/billing-copy.ts` and `components/settings/billing-band.tsx` both name `BillingView`,
   * and both must do it with `import type`, which is erased.
   */
  it('is reachable only from server modules and route handlers', () => {
    const importers = FILES.filter((f) => /^import Stripe from ['"]stripe['"]/m.test(f.source))
      .map((f) => f.path)
      .filter((path) => !path.startsWith('server/billing/'))
    expect(importers).toEqual([])
  })

  it('is only ever type-imported outside the server billing modules', () => {
    const offenders = FILES.filter(
      (f) =>
        !f.path.startsWith('server/billing/') &&
        /^import (?!type )[^;]*from ['"]stripe['"]/m.test(f.source),
    ).map((f) => f.path)
    expect(offenders).toEqual([])
  })

  /**
   * NO `apiVersion`. Since stripe-node v12 the SDK sends the version it was built against, and
   * that version is what makes its TypeScript types accurate — Stripe's own docs warn that
   * overriding it produces inaccurate types. The npm pin IS the API version, which is why
   * `stripe` is pinned exactly rather than with a caret.
   */
  it('is constructed without pinning an API version by hand', () => {
    const constructors = FILES.filter((f) => /new Stripe\(/.test(f.source))
    expect(constructors.length).toBeGreaterThan(0)
    for (const { path, source } of constructors) {
      expect(code(source), `${path} overrides apiVersion`).not.toMatch(/apiVersion\s*:/)
    }
  })
})
