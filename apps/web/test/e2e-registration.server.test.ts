import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Every spec in e2e/ is claimed by a project, and the two device allowlists agree.
 *
 * playwright.config.ts's `mobile` and `desktop` projects each carry their OWN copy of the
 * same testMatch regex, so a new spec nobody remembers to name is collected by no project
 * and silently never runs — the suite reports green while checking nothing. That is the same
 * orphan the visual baselines had for the entire life of that file, under a CI step named
 * "E2E, accessibility and visual" that was running neither.
 *
 * Naming a spec in ONE of the two is the worse failure and the reason for the second test
 * here: half the coverage, reported as all of it, with no signal anywhere. It would mean a
 * spec ran at one breakpoint only, which for a project whose layout bugs are overwhelmingly
 * viewport-shaped is close to not running it.
 *
 * Written while adding e2e/plan.spec.ts, because the trap is documented in CLAUDE.md, has
 * now cost this project twice, and a comment is not a guard.
 */

const root = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const config = readFileSync(root('../../../playwright.config.ts'), 'utf8')

/** Every `testMatch:` literal in the config, in source order. */
const matchers: readonly string[] = [
  ...config.matchAll(/testMatch:\s*(\/.+?\/)(?=,\s*$)/gmu),
].flatMap((match) => (match[1] === undefined ? [] : [match[1]]))

/** A `/body/flags` source literal, back into a usable RegExp. */
const compile = (literal: string): RegExp => {
  const end = literal.lastIndexOf('/')
  return new RegExp(literal.slice(1, end), literal.slice(end + 1))
}

const specs = readdirSync(root('../../../e2e')).filter((file) => file.endsWith('.spec.ts'))

describe('the e2e allowlists', () => {
  it('found the config and its spec directory', () => {
    // If either of these ever reads zero the tests below pass vacuously, which is precisely
    // the failure mode they exist to prevent.
    expect(matchers.length).toBeGreaterThanOrEqual(2)
    expect(specs.length).toBeGreaterThan(0)
  })

  it('names every spec in at least one project allowlist', () => {
    const orphans = specs.filter(
      (spec) => !matchers.some((literal) => compile(literal).test(`e2e/${spec}`)),
    )
    expect(orphans, 'these spec files are collected by no project and never run').toEqual([])
  })

  it('gives the two device projects identical allowlists', () => {
    // `visual` and `a11y` are deliberately pinned to one project each, so only the first two
    // — mobile and desktop — are compared. They have never intentionally differed, and a
    // one-sided edit is invisible from the outside.
    const [mobile, desktop] = matchers
    expect(mobile).toBe(desktop)
  })
})
