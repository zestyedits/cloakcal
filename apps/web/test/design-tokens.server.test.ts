import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Every design token a stylesheet references actually exists.
 *
 * THIS IS NOT HOUSEKEEPING. An undefined custom property is invalid at computed-value time,
 * which does not fall back to something sensible — it takes the WHOLE declaration with it. So
 * `animation: sweep 900ms var(--ease-out) both` where `--ease-out` does not exist is not a
 * slightly-wrong easing curve; it is no animation at all, silently.
 *
 * That is exactly what shipped. `--ease-out` was invented from muscle memory (the real tokens
 * are --ease-standard, --ease-decelerate, --ease-accelerate, --ease-spring) and used in two
 * files. The landing hero's reseal wipe and its sweep both did nothing, and the sweep's
 * gradient sat frozen mid-grid as a permanent light streak that read as a rendering artefact.
 * Typecheck cannot see it, axe cannot see it, and the visual baselines' 2% threshold is far
 * too coarse. It was caught by opening a screenshot and asking why the streak had not moved.
 *
 * Fallbacks like `var(--x, 8px)` are deliberately allowed: a declared fallback is a
 * considered decision, and the failure mode this test exists to catch is the absence of one.
 */

const root = (path: string) => fileURLToPath(new URL(path, import.meta.url))

/** Every custom property tokens.css and globals.css DECLARE. */
const declared = (): ReadonlySet<string> => {
  const names = new Set<string>()
  for (const file of [
    root('../../../packages/ui/src/tokens.css'),
    root('../src/app/globals.css'),
  ]) {
    for (const match of readFileSync(file, 'utf8').matchAll(/(--[\w-]+)\s*:/gu)) {
      names.add(match[1]!)
    }
  }
  return names
}

/** Every file under src matching an extension, recursively. */
const walk = (dir: string, extension: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(`${dir}/${entry.name}`, extension)
      : entry.name.endsWith(extension)
        ? [`${dir}/${entry.name}`]
        : [],
  )

/**
 * Custom properties set from a component's `style` prop rather than from CSS.
 *
 * `--from`, `--span`, `--col` and `--hour-count` are per-instance geometry — a block's
 * position IS its data — so they are written in TSX and read in CSS. They are declared, just
 * not where this test would otherwise look, and treating them as missing would make the
 * sweep below cry wolf on the four files that do the most interesting layout.
 */
const inlineProperties = (dir: string): ReadonlySet<string> => {
  const names = new Set<string>()
  for (const file of walk(dir, '.tsx')) {
    for (const match of readFileSync(file, 'utf8').matchAll(/'(--[\w-]+)'\s*:/gu)) {
      names.add(match[1]!)
    }
  }
  return names
}

describe('design tokens', () => {
  const known = new Set([...declared(), ...inlineProperties(root('../src'))])
  const files = walk(root('../src'), '.module.css')

  it('found the token declarations and the stylesheets', () => {
    // Without this the sweep below passes vacuously if either path ever moves.
    expect(known.size).toBeGreaterThan(80)
    expect(files.length).toBeGreaterThan(10)
  })

  it('references no custom property that is never declared', () => {
    const missing: string[] = []

    for (const file of files) {
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')

      // Properties this stylesheet defines for itself — --row-h, --col, --span and friends
      // are local, set either in the file or from the component's style attribute.
      const local = new Set(
        [...css.matchAll(/(--[\w-]+)\s*:/gu)].map((m) => m[1]!),
      )

      for (const use of css.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/gu)) {
        const name = use[1]!
        // A declared fallback is a decision; only a bare reference is a bug.
        if (use[2] === ',') continue
        if (local.has(name) || known.has(name)) continue
        missing.push(`${file.slice(file.indexOf('/src/'))}: ${name}`)
      }
    }

    expect([...new Set(missing)], 'undefined tokens silently void the whole declaration').toEqual(
      [],
    )
  })
})
