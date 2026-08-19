import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A PROP THAT IS IN A DEPENDENCY ARRAY MAY NOT DEFAULT TO A FRESH OBJECT.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS EXISTS TO STOP HAPPENING AGAIN
 * ---------------------------------------------------------------------------
 *
 * `CloakProvider` declared `extraFields = []` as an inline default, and `extraFields` is in
 * its unlock effect's dependency array. An inline `[]` is a NEW ARRAY ON EVERY RENDER, so a
 * caller that simply omitted the prop got: effect runs, `setStore` re-renders, fresh `[]`,
 * effect runs again, forever.
 *
 * What makes it worth a test is how it presents, which is not as a hang. The page paints. The
 * frame cadence stays at 16ms. `page.evaluate` answers immediately. A synthetic `el.click()`
 * works and does the right thing. The ONLY symptom is that the renderer never finishes
 * acknowledging a real input event — so in a browser every click on the page does nothing, and
 * in Playwright every `click()` sits in its dispatch until the test times out, with a call log
 * that stops after "performing click action" and names nothing.
 *
 * Finding it took bisecting the page down to an empty `<main>` and watching it still fail.
 * Four of the five call sites passed a memoised value, as the prop's own JSDoc asks; the fifth
 * omitted the prop, which reads like the one case the instruction cannot be about.
 *
 * The real fix is the stable module constant in `cloak-provider.tsx`. This is the guard that
 * stops the next component reintroducing the pattern, because the failure is silent enough
 * that nobody would think to look here.
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

/** Line comments FIRST — see legal-claims.server.test.ts for what the other order eats. */
const code = (source: string): string =>
  source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

const FILES = walk(SRC).map((path) => ({
  path,
  source: code(readFileSync(join(SRC, path), 'utf8')),
}))

/** Every identifier named inside a `useEffect`/`useMemo`/`useCallback` dependency array. */
function dependencyNames(source: string): Set<string> {
  const names = new Set<string>()
  for (const match of source.matchAll(/\}\s*,\s*\[([^\]]*)\]\s*\)/g)) {
    for (const raw of (match[1] ?? '').split(',')) {
      // `page?.timezone` and `prefs?.defaultView` both depend on the base identifier.
      const name = raw.trim().split(/[.?[]/)[0]?.trim() ?? ''
      if (name !== '') names.add(name)
    }
  }
  return names
}

/** Destructured props given an inline `[]` or `{}` default. */
function freshObjectDefaults(source: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(/(\w+)\s*=\s*(\[\s*\]|\{\s*\})\s*[,}]/g)) {
    found.push(match[1] ?? '')
  }
  return found
}

describe('a destructured default that is rebuilt every render', () => {
  it('never lands in a dependency array', () => {
    const offenders: string[] = []
    for (const { path, source } of FILES) {
      const deps = dependencyNames(source)
      for (const name of freshObjectDefaults(source)) {
        if (deps.has(name)) offenders.push(`${path}: \`${name}\` defaults to a new object`)
      }
    }
    expect(
      offenders,
      'An inline [] or {} default is a fresh identity per render. In a dependency array that is an unbounded effect loop, and it presents as clicks doing nothing rather than as a hang. Hoist the default to a module constant.',
    ).toEqual([])
  })

  it('would catch the defect it was written for', () => {
    // The sweep above passes when nothing does the wrong thing, and also when either matcher
    // is broken. This is the difference, and it is not hypothetical: the exact text below is
    // what `cloak-provider.tsx` carried.
    const bad = `
      export function Thing({ page, extraFields = [], children }) {
        useEffect(() => {
          void extraFields
        }, [page, extraFields, attempt])
      }
    `
    expect(freshObjectDefaults(bad)).toContain('extraFields')
    expect(dependencyNames(bad).has('extraFields')).toBe(true)

    const good = `
      const NO_EXTRA_FIELDS = Object.freeze([])
      export function Thing({ page, extraFields = NO_EXTRA_FIELDS }) {
        useEffect(() => {
          void extraFields
        }, [page, extraFields, attempt])
      }
    `
    expect(freshObjectDefaults(good)).not.toContain('extraFields')
  })

  it('reads a real source tree, so it cannot pass vacuously', () => {
    expect(FILES.length).toBeGreaterThan(50)
    const withDeps = FILES.filter((f) => dependencyNames(f.source).size > 0)
    expect(withDeps.length).toBeGreaterThan(5)
  })
})
