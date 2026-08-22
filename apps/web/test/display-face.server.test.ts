import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The display face stays out of the app.
 *
 * Marcellus and the four `--tracking-engraved-*` tokens were a real system: the face has
 * exactly ONE weight, so letter-spacing carried the emphasis a bold would normally give,
 * and the tokens' own comments warn against "unifying" them with Inter's caps tracking.
 * The 2026-08-22 mobile pass retired it from every FUNCTIONAL surface — one sans for
 * anything you read to operate the product — and kept it where it earns its keep: the
 * landing page and the marketing hero.
 *
 * THIS IS A SWEEP BECAUSE THE FAILURE IS GRADUAL. Nothing breaks when one component
 * reaches for the display face; it just looks a bit special, and then the next one does,
 * and the system is back without a decision ever being taken. Twenty-four stylesheets had
 * to be rewritten to get here, which is the cost of noticing late.
 *
 * `root` takes its path as a VARIABLE, and that is load-bearing rather than style: Vite
 * statically rewrites `new URL('<literal>', import.meta.url)` into an asset URL, so the
 * inline spelling resolves to an http: URL under jsdom and `fileURLToPath` throws. The
 * same trap is documented in CLAUDE.md and in passkey-ui.client.test.ts.
 */

const root = (path: string) => fileURLToPath(new URL(path, import.meta.url))

/**
 * Where the display face is still allowed, and why each one earns it.
 *
 * Marketing only. A form label, a settings row and a calendar block are things you read to
 * DO something, and they get the UI face; a landing hero is a brand moment and does not.
 */
const ALLOWED = new Set(['landing.module.css', 'landing-calendar.module.css'])

const stylesheets = (dir: string, found: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`
    if (entry.isDirectory()) stylesheets(full, found)
    else if (entry.name.endsWith('.module.css')) found.push(full)
  }
  return found
}

describe('the display face is marketing-only', () => {
  const files = stylesheets(root('../src'))

  /*
   * A SWEEP THAT CANNOT SAY WHAT IT INSPECTED CANNOT TELL YOU IT FOUND NOTHING FROM IT
   * LOOKED AT NOTHING. This repo has already shipped one sweep that passed while every
   * element it meant to measure had been clipped to 1x1 and skipped.
   */
  it('inspects every stylesheet under src', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it.each(['--font-display', '--tracking-engraved'])(
    'no functional stylesheet names %s',
    (token) => {
      const offenders = files
        .filter((file) => readFileSync(file, 'utf8').includes(token))
        .filter((file) => !ALLOWED.has(file.slice(file.lastIndexOf('/') + 1)))
        .map((file) => file.slice(file.indexOf('/src/') + 5))
      expect(offenders).toEqual([])
    },
  )

  /*
   * The allowlist has to keep EARNING itself. If the landing page stops using the face,
   * the entry should go rather than sit there permitting a future reintroduction.
   */
  it('every allowlisted file still uses it', () => {
    const usedBy = files
      .filter((file) => ALLOWED.has(file.slice(file.lastIndexOf('/') + 1)))
      .filter((file) => readFileSync(file, 'utf8').includes('--font-display'))
      .map((file) => file.slice(file.lastIndexOf('/') + 1))
    expect(new Set(usedBy)).toEqual(ALLOWED)
  })
})
