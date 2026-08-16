import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Static architectural rule: a server module may not import the decryption packages.
 *
 * The runtime guard in CloakStore throws if constructed off-browser, but that only fires
 * if the code runs. This catches the mistake earlier and more reliably — at the import
 * graph — because the dangerous version is the one that never throws in development and
 * only decrypts during a production SSR render.
 *
 * A module counts as SERVER unless it is explicitly marked `'use client'`. That default
 * matters: in the Next App Router, everything is a Server Component until it opts out, so
 * a permissive default here would silently exempt every new file someone forgets to mark.
 */

const REPO = fileURLToPath(new URL('../../..', import.meta.url))

/** Packages that must never be reachable from a server module. */
const CLIENT_ONLY_PACKAGES = ['@cloakcal/cloak-store', '@cloakcal/crypto']

/**
 * PACKAGES WHOSE MAIN ENTRY RE-EXPORTS ONE OF THE ABOVE, so importing them from a server
 * module launders the ban.
 *
 * `@cloakcal/db`'s `src/index.ts` re-exports `./events.js`, which imports `@cloakcal/crypto` on
 * its first line. Until the billing work, `apps/web` did not depend on `@cloakcal/db` at all, so
 * the specifier would not even resolve from there and the two literals above were a complete
 * list. Adding the dependency — for the zero-import `@cloakcal/db/billing-queries` subpath —
 * unlocked a door this rule exists to keep shut, and left it unwatched.
 *
 * The SUBPATH is what apps/web is allowed to reach, and it is a leaf module with no imports at
 * all. The main entry is not. Matching on the bare specifier and on any subpath other than the
 * allowed one keeps the useful import and closes the laundering route.
 */
const LAUNDERING: readonly { readonly pkg: string; readonly allow: readonly string[] }[] = [
  { pkg: '@cloakcal/db', allow: ['@cloakcal/db/billing-queries'] },
]

/** Roots that ship application code. Test files and the packages themselves are excluded. */
const SCAN_ROOTS = ['apps']

const IGNORED_DIRS = new Set(['node_modules', '.next', 'dist', '.git', 'coverage', 'test-results'])

async function* walk(dir: string): AsyncGenerator<string> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // Root does not exist yet — apps/web arrives with the shell.
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) yield full
  }
}

interface Module {
  readonly path: string
  readonly source: string
  readonly isClient: boolean
  readonly isExplicitServer: boolean
}

async function collectModules(): Promise<Module[]> {
  const out: Module[] = []
  for (const root of SCAN_ROOTS) {
    for await (const path of walk(join(REPO, root))) {
      if (/\.(test|spec)\.[tj]sx?$/.test(path)) continue
      const source = await readFile(path, 'utf8')
      const head = source.slice(0, 400)
      out.push({
        path: relative(REPO, path).split(sep).join('/'),
        source,
        isClient: /^\s*(['"])use client\1/m.test(head),
        isExplicitServer: /^\s*(['"])use server\1/m.test(head),
      })
    }
  }
  return out
}

const escape = (pkg: string) => pkg.replace(/[/@-]/g, (c) => `\\${c}`)

const importsAny = (source: string, packages: readonly string[]): string[] =>
  packages.filter((pkg) => {
    const escaped = escape(pkg)
    return new RegExp(`from\\s+['"]${escaped}(/[^'"]*)?['"]|require\\(['"]${escaped}`).test(source)
  })

/**
 * Which laundering packages a module reaches by a specifier that is not on their allowlist.
 *
 * Captures the whole specifier so the allowlist can be compared exactly, rather than by
 * prefix: `@cloakcal/db/billing-queries-and-also-events` must not pass because it starts the
 * same way.
 */
const launders = (source: string): string[] => {
  const found: string[] = []
  for (const { pkg, allow } of LAUNDERING) {
    const pattern = new RegExp(
      `from\\s+['"](${escape(pkg)}(?:/[^'"]*)?)['"]|require\\(['"](${escape(pkg)}(?:/[^'"]*)?)['"]`,
      'g',
    )
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1] ?? match[2]
      if (specifier !== undefined && specifier !== pkg && allow.includes(specifier)) continue
      if (specifier !== undefined) found.push(specifier)
    }
  }
  return found
}

describe('server modules cannot reach the decryption packages', () => {
  /**
   * THE INDIRECT ROUTE, WHICH WAS OPEN FOR EXACTLY ONE COMMIT.
   *
   * `@cloakcal/db`'s main entry re-exports a module that imports `@cloakcal/crypto`, so
   * `import { anything } from '@cloakcal/db'` in a server file reaches the ban's target
   * without naming it. Before the billing work `apps/web` had no dependency on
   * `@cloakcal/db`, so the specifier did not resolve and the two-literal list above was
   * genuinely complete. Adding the dependency for a leaf subpath unlocked the door.
   *
   * The allowed subpath is a module with ZERO imports, which is the property that makes it
   * safe and which `packages/db/src/billing-queries.ts` states in its own header.
   */
  it('finds no server module reaching a client-only package through a re-export', async () => {
    const modules = await collectModules()
    const violations = modules
      .filter((m) => !m.isClient)
      .map((m) => ({ path: m.path, imports: launders(m.source) }))
      .filter((v) => v.imports.length > 0)

    expect(violations).toEqual([])
  })

  it('would catch that route if somebody took it', async () => {
    // The sweep above passes when nothing does the wrong thing, which is also what it does
    // when the pattern is broken. This proves the pattern still fires.
    expect(launders(`import { events } from '@cloakcal/db'`)).toEqual(['@cloakcal/db'])
    expect(launders(`import x from '@cloakcal/db/events'`)).toEqual(['@cloakcal/db/events'])
    // And that the one specifier apps/web is allowed to use still passes.
    expect(launders(`import { UUID } from '@cloakcal/db/billing-queries'`)).toEqual([])
  })

  it('finds no server module importing a client-only package', async () => {
    const modules = await collectModules()
    const violations = modules
      .filter((m) => !m.isClient)
      .map((m) => ({ path: m.path, imports: importsAny(m.source, CLIENT_ONLY_PACKAGES) }))
      .filter((v) => v.imports.length > 0)

    expect(violations).toEqual([])
  })

  it('finds no server action importing a client-only package', async () => {
    // 'use server' files are the sharpest case: their arguments cross the network, so
    // plaintext reaching one would be sent to the server by definition.
    const modules = await collectModules()
    const violations = modules
      .filter((m) => m.isExplicitServer)
      .map((m) => ({ path: m.path, imports: importsAny(m.source, CLIENT_ONLY_PACKAGES) }))
      .filter((v) => v.imports.length > 0)

    expect(violations).toEqual([])
  })

  it('finds no route handler importing a client-only package', async () => {
    const modules = await collectModules()
    const violations = modules
      .filter((m) => /\/route\.[tj]sx?$/.test(m.path))
      .map((m) => ({ path: m.path, imports: importsAny(m.source, CLIENT_ONLY_PACKAGES) }))
      .filter((v) => v.imports.length > 0)

    expect(violations).toEqual([])
  })

  it('detects the violation it is meant to detect', async () => {
    // Guards against the rule silently passing because the matcher is broken — the same
    // class of vacuous-green the verifyRange straddle check exists to prevent.
    const fake = `import { createCloakStore } from '@cloakcal/cloak-store'\nexport default function Page() {}`
    expect(importsAny(fake, CLIENT_ONLY_PACKAGES)).toContain('@cloakcal/cloak-store')

    const alsoFake = `import { uncloakField } from "@cloakcal/crypto"`
    expect(importsAny(alsoFake, CLIENT_ONLY_PACKAGES)).toContain('@cloakcal/crypto')

    const innocent = `import { expandSeries } from '@cloakcal/domain'`
    expect(importsAny(innocent, CLIENT_ONLY_PACKAGES)).toEqual([])
  })

  it('treats an unmarked module as server, matching the App Router default', async () => {
    const modules = await collectModules()
    for (const m of modules) {
      if (!/^\s*(['"])use client\1/m.test(m.source.slice(0, 400))) {
        expect(m.isClient).toBe(false)
      }
    }
  })
})
