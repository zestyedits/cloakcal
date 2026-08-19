import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * RULE 1, ON THE SURFACES THAT ACTUALLY SHIP.
 *
 * `plan-catalog.server.test.ts` already owns the right regexes, and they were written after a
 * real overstatement: "Your events, encrypted in this browser" claims the EVENT is encrypted
 * when times, durations, repeats and calendar membership are all stored in the clear. But it
 * points them at `PLANS.flatMap((tier) => tier.includes)` — ten strings in one array, on a page
 * nobody can buy anything from.
 *
 * Meanwhile `landing.tsx`, the highest-traffic copy surface in the product and the page a
 * journalist would quote, was guarded by two assertions: one em-dash check and one flag read.
 * It shipped "CloakCal encrypts your events on your device" above the fold — the identical
 * claim, found and fixed once, never propagated. That is the whole reason this file exists: the
 * fix already existed elsewhere, and the guard's SCOPE was what let it come back.
 *
 * `legal.ts` is deliberately not swept here. It has its own two files, and they read the
 * structured document rather than its source, which is stricter than a text scan can be.
 *
 * COMMENTS ARE STRIPPED, LINE ONES FIRST, and the order is load-bearing rather than tidy. Doing
 * blocks first is the obvious way round and it is wrong: a line comment mentioning a path like
 * an api wildcard opens a block the matcher then closes at the next block terminator it finds,
 * swallowing everything between. It ate 3,884 characters of export-calendar.tsx once and made a
 * sweep report a feature missing while it sat four lines below the comment that hid it.
 *
 * Stripping matters twice as much here as elsewhere, because this repo COMMENTS ITS REASONING.
 * Half the files below carry a paragraph explaining why a claim was rejected, and a sweep that
 * read those would fail on the explanation of its own rule.
 */

const SRC = join(__dirname, '..', 'src')

const code = (source: string): string =>
  source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * Every user-facing surface outside the legal documents.
 *
 * A DIRECTORY WALK, not a hand-written list, and that is the point — a list is the thing that
 * goes stale. A new screen is swept the day it is added, without anyone remembering to come
 * here. `lib/` is included for the copy that lives in catalogs (plans, billing sentences).
 */
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return walk(path)
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : []
  })

const SURFACES = [join(SRC, 'components'), join(SRC, 'app'), join(SRC, 'lib')]
  .flatMap(walk)
  // legal.ts has its own guards, which read the structured document rather than the source.
  .filter((path) => !path.endsWith(join('lib', 'legal.ts')))
  .map((path) => ({ path: path.slice(SRC.length + 1), source: code(readFileSync(path, 'utf8')) }))

/**
 * A NEGATION CLOSE ENOUGH TO GOVERN THE PHRASE, which is the difference between a claim and a
 * disclaimer.
 *
 * The first version of this file banned the phrases outright and went red on two files:
 * `plan-screen.tsx` ("is not zero knowledge: the server stores times, durations, repeats and
 * calendar membership") and `app/privacy/page.tsx` ("CloakCal is not zero-knowledge and says
 * so"). Both are the product doing precisely the right thing, and the only way to go green
 * would have been to DELETE THE DISCLAIMER — a guard that punishes the honest sentence and
 * rewards silence, which is the exact inversion of the rule it enforces.
 *
 * So the check is polarity-aware: it reads the text before the match on that line and skips it
 * when a negation is near enough to govern it. Scoped to the line and to 40 characters, because
 * a negation four sentences upstream governs nothing.
 */
const NEGATED = /\b(?:not|never|cannot|rather than|no)\b[^.]{0,40}$/i

/** Files whose SOURCE makes the CLAIM, so a failure names the file rather than "somewhere". */
const offenders = (pattern: RegExp): string[] =>
  SURFACES.filter((file) =>
    file.source.split(/\r?\n/).some((line) => {
      const at = line.search(pattern)
      return at !== -1 && !NEGATED.test(line.slice(0, at))
    }),
  ).map((file) => file.path)

describe('no surface overstates what is encrypted', () => {
  /*
   * The exact claim that shipped, twice. "Your events, encrypted" and "events are encrypted"
   * both assert the EVENT is sealed; what is sealed is what the event SAYS. That distinction is
   * the product's entire honesty position and it is one word wide, which is precisely why it
   * needs a machine rather than a reviewer.
   */
  it('never says the events themselves are encrypted', () => {
    expect(offenders(/\byour events,? encrypted|\bevents are encrypted/iu)).toEqual([])
  })

  /*
   * CloakCal is NOT zero-knowledge and must never be marketed as such. The server stores times,
   * durations, recurrence and calendar membership in plaintext because booking, reminders and
   * conflict detection need them. Rule 1 of CLAUDE.md, stated as a ban because the phrase is
   * the single most tempting thing anyone could write about this product.
   */
  it('never claims zero-knowledge', () => {
    expect(offenders(/zero.?knowledge/iu)).toEqual([])
  })
})

describe('no surface sells a capability that is not built', () => {
  /*
   * `access_envelopes` is unused and `deriveFieldKey` returns a NON-EXTRACTABLE key, so no
   * envelope material can be read out of it: nothing in this product can be sent to anyone.
   *
   * "Anyone with the link" is honest on a settings CONTROL, where it names a rule you are
   * setting for a capability that will exist. In a feature list or a hero it reads as something
   * that works today. These regexes are deliberately narrow for that reason — they ban the
   * promise, not the vocabulary.
   */
  it('promises no share link', () => {
    expect(offenders(/share (?:a )?link (?:with|to)|send(?:ing)? (?:them )?a link/iu)).toEqual([])
  })

  /*
   * Reminders are not merely unbuilt, they are UNWRITABLE: create_cloaked_event takes no
   * reminder parameter, event-fields.tsx has no control, and reminder_offsets has been empty on
   * every row since 0001. Five surfaces once justified readable times with "because reminders
   * need them", which is copy cashing a cheque on a capability that does not exist.
   */
  it('promises no reminder that will actually fire', () => {
    expect(offenders(/we(?:'| a)?ll remind you|you can set a reminder/iu)).toEqual([])
  })
})
