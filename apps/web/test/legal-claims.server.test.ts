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
    name: 'Reminders',
    /*
     * Present tense only. "Features that would also need them, like reminders and booking,
     * are planned rather than built" must NOT match — describing a plan is allowed, and is
     * what the copy does now.
     *
     * Five surfaces used to justify readable times with "because reminders need them". Not
     * false — it was the honest original design reason — but it is the export claim's shape:
     * copy cashing a cheque on an unbuilt capability, on the pages whose whole job is to be
     * believed. reminder_offsets is not merely unread, it is UNWRITABLE: create_cloaked_event
     * takes no reminder parameter and event-fields.tsx has no control.
     */
    claim: /reminders? (?:will |can )?(?:remind|notify|alert)|we(?:'| a)?ll remind you|you can set a reminder/i,
    // A scheduler or a notification path. Neither exists: no vercel.json crons key, no
    // app/api/cron route, Resend is not a dependency of apps/web, and there is no service
    // worker. Any of these appearing means reminders became real.
    backing: /showNotification|requestPermission|serviceWorker|api\/cron/,
    why: 'the same shape as the export claim, caught before it shipped',
  },
  {
    name: 'Trash and permanent deletion',
    /*
     * A LIVE CLAIM, added with the control rather than after it -- which is the whole
     * lesson of the export sentence that sat here false for months.
     *
     * Making the trash VISIBLE turns indefinite retention from an implementation detail
     * into a promise: the policy now says an event waits there until you act, and that a
     * permanent removal erases the ciphertext while leaving a content-free audit row. All
     * three halves have to move together, so the pairing is asserted rather than trusted.
     *
     * The backing is the RPC NAME, not a component or a heading. Prose never calls an
     * RPC, and purge is the only thing in the product that destroys ciphertext -- if it
     * is ever removed, this sentence must go with it.
     */
    claim: /moves it to Trash|remove it permanently|erases its encrypted content/i,
    backing: /purge_cloaked_event/,
    why: 'the retention promise a visible trash creates',
  },
  {
    name: 'A contact page',
    /*
     * ADDED WITH THE PAGE, IN THE SAME CHANGE, WHICH IS THE ENTIRE LESSON OF THIS FILE.
     *
     * Both documents now send the reader to "our contact page" in four places, and one of
     * those sentences is the privacy policy's answer to a statutory erasure request. That is
     * the export sentence's exact position: a direction to a destination, sitting in the
     * section a regulator reads. If the route is ever deleted or renamed, this goes red rather
     * than leaving four dead pointers in the one document that cannot afford them.
     */
    claim: /contact page/i,
    /*
     * The route constant, which is what `PUBLIC_PATHS` and every link into the page actually
     * use. Not the address — `SUPPORT_EMAIL` would be satisfied by the settings page's mailto,
     * which existed before this work and is precisely the state the copy is no longer
     * describing. Not a heading or a component name either: those are words, and words are
     * what this file refuses to accept as evidence.
     */
    backing: /CONTACT_PATH/,
    why: 'four sentences now point at a page, which is the shape the export claim failed in',
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
    /*
     * "our contact page" JOINED "from Settings" HERE, and it is the more dangerous of the two.
     * A sentence sending somebody to Settings is read by an account holder who can see whether
     * the thing is there. A sentence sending somebody to a contact page is read by a stranger
     * with no account and, in the erasure paragraph, by a regulator — neither of whom has any
     * other way to reach a human if the pointer is wrong.
     */
    const directions = SENTENCES.filter((s) =>
      /(?:from|in|on) Settings|contact page/i.test(s),
    )
    expect(directions.length).toBeGreaterThan(0)

    const unknown = directions.filter(
      (sentence) => !CAPABILITIES.some((c) => c.claim.test(sentence) && built(c.backing)),
    )
    expect(unknown).toEqual([])
  })
})
