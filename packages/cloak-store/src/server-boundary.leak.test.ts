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

const importsAny = (source: string, packages: readonly string[]): string[] =>
  packages.filter((pkg) => {
    const escaped = pkg.replace(/[/@-]/g, (c) => `\\${c}`)
    return new RegExp(`from\\s+['"]${escaped}(/[^'"]*)?['"]|require\\(['"]${escaped}`).test(source)
  })

describe('server modules cannot reach the decryption packages', () => {
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
