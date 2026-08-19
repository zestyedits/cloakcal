import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LEGAL_DOCUMENTS } from '@/lib/legal'

/**
 * THE LEGAL DOCUMENTS MAY NOT CLAIM A CAPABILITY THAT IS NOT BUILT.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS EXISTS TO STOP HAPPENING AGAIN
 * ---------------------------------------------------------------------------
 *
 * The privacy policy said, in the present tense and naming a location:
 *
 *   "You can export your calendar as a standard .ics file at any time, from Settings."
 *
 * Settings said "Export - Coming soon", and no such control had ever existed. The sentence
 * sat in the statutory-rights section, two lines above the paragraph invoking UK/EU/California
 * portability, so a false statement was the page's answer to a legal obligation.
 *
 * The bullet DIRECTLY BELOW it got deletion right - "There is no button for this yet, and we
 * would rather say so than point you at one that is not there" - which is the tell. The rule
 * was known and written down one line away. What was missing was anything that could check it.
 *
 * Prose is the only surface in this repo with no compiler and no test, which is exactly why it
 * drifted first. Every other honesty claim here is guarded: `signup-enumeration` forbids the
 * tempting branch, `plan-badge` greps the write path, `security-headers` pins the CSP. This is
 * the same instinct pointed at the one place nobody had pointed it.
 *
 * BICONDITIONAL, DELIBERATELY. Each capability asserts claimed === built, so the guard fires
 * in BOTH directions: it catches copy that overstates, and it catches a feature shipping while
 * the copy still calls it missing. A one-directional check would go quiet the moment export
 * lands and let the "not built yet" wording rot in place.
 */

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

function walk(dir: string, prefix = ''): string[] {
  let found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const rel = prefix === '' ? entry : prefix + '/' + entry
    if (statSync(full).isDirectory()) found = found.concat(walk(full, rel))
    else if (/\.tsx?$/.test(entry)) found.push(rel)
  }
  return found
}

/**
 * Copy modules are what the claims are MADE in, so they can never be the evidence a claim is
 * backed. Without this, `plans.ts` naming ".ics" in a roadmap entry would satisfy the export
 * check and the whole file would prove nothing.
 */
const PROSE = new Set(['lib/legal.ts', 'lib/plans.ts'])

/**
 * Comments stripped, in the house style of billing-boundary.server.test.ts.
 *
 * NOT optional, and it was caught by testing the guard rather than by writing it: the export
 * route's own doc comment explains why it does NOT return `text/calendar`, and a raw-source
 * scan matched those words. The file went green while the implementation it was looking for
 * had been removed — a guard satisfied by a sentence describing its own absence.
 *
 * LINE COMMENTS COME OFF FIRST, AND THE ORDER IS LOAD-BEARING. Doing blocks first is the
 * obvious way round and it is wrong: a line comment mentioning a path like `/api/*` opens a
 * block the matcher then closes at the next `*​/` it can find, swallowing everything between.
 * That is not hypothetical — it ate 3,884 characters of `export-calendar.tsx`, including the
 * only line this file was looking for, and the sweep reported the feature missing while it
 * sat four lines below the comment that hid it. Same family as the `[^;]*` warning in
 * CLAUDE.md: a source-scanning regex with nothing to stop it runs until something else does.
 */
const code = (source: string): string =>
  source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

const IMPLEMENTATION = walk(SRC)
  .filter((path) => !PROSE.has(path))
  .map((path) => ({ path, source: code(readFileSync(join(SRC, path), 'utf8')) }))

const built = (pattern: RegExp): boolean => IMPLEMENTATION.some((f) => pattern.test(f.source))

/** Every sentence in every legal document, flattened. */
const SENTENCES = LEGAL_DOCUMENTS.flatMap((doc) =>
  doc.sections.flatMap((section) => section.body),
)
const ALL_COPY = SENTENCES.join('\n')

interface Capability {
  readonly name: string
  /** Does the copy assert this is available TODAY? */
  readonly claim: RegExp
  /** Does an implementation exist? Never satisfied by prose. */
  readonly backing: RegExp
  readonly why: string
}

const CAPABILITIES: readonly Capability[] = [
  {
    name: 'Export to .ics',
    // Present tense only. "Export is not built yet. When it is, your calendar will come out
    // as a standard .ics file" must NOT match - describing a plan is allowed, and is what the
    // copy does today.
    claim: /you can export|export your calendar (?:at any time|from Settings)/i,
    // The RFC 5545 media type. Unambiguously implementation: prose never sets a MIME type,
    // and any real export has to.
    backing: /text\/calendar/,
    why: 'the exact claim that shipped false',
  },
  {
    name: 'Self-serve account deletion',
    claim: /delete your account (?:from|in) Settings|delete your own account/i,
    backing: /deleteAccount|delete_account/,
    why: 'deletion is by email today, and the copy says so',
  },
  {
    name: 'Cancelling a subscription from Settings',
    claim: /cancel from Settings/i,
    backing: /cancelAtPeriodEnd|kind: 'cancel'/,
    why: 'a TRUE claim, so this file is not just a way of saying no to everything',
  },
]

describe('every capability the legal documents claim is actually built', () => {
  it.each(CAPABILITIES.map((c) => [c.name, c] as const))('%s', (_name, capability) => {
    const claimed = capability.claim.test(ALL_COPY)
    const exists = built(capability.backing)

    expect(
      claimed,
      claimed
        ? `The legal documents say "${capability.name}" works, and nothing matching ${String(capability.backing)} exists. Build it or reword the claim (${capability.why}).`
        : `"${capability.name}" is built but the legal documents still describe it as unavailable. Update the copy (${capability.why}).`,
    ).toBe(exists)
  })

  it('covers at least one claim that is true, and one that is not', () => {
    // Without this the suite could pass by every detector being broken and every capability
    // reading false === false, which is a green light with nothing behind it.
    const states = CAPABILITIES.map((c) => c.claim.test(ALL_COPY))
    expect(states).toContain(true)
    expect(states).toContain(false)
  })
})

describe('pointing at a place implies something is there', () => {
  it('names a known capability in every sentence that sends the reader to Settings', () => {
    /*
     * The SHAPE of the original bug, generalised: it did not merely overstate, it told the
     * reader where to go. A sentence naming a destination is the most damaging kind of false
     * claim, because the reader goes and looks.
     */
    const directions = SENTENCES.filter((s) => /(?:from|in|on) Settings/i.test(s))
    expect(directions.length).toBeGreaterThan(0)

    const unknown = directions.filter(
      (sentence) => !CAPABILITIES.some((c) => c.claim.test(sentence) && built(c.backing)),
    )
    expect(unknown).toEqual([])
  })
})
