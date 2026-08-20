import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  armFirstRun,
  dismissAudiencePrompt,
  isAudiencePromptDismissed,
  isFirstRunArmed,
  shouldOfferAudiencePrompt,
} from '../src/lib/first-run'

/**
 * The first-contact prompt's decision, covered at the only level this repo can cover it.
 *
 * ---------------------------------------------------------------------------
 * WHY A PREDICATE TEST AND NOT A RENDER TEST
 * ---------------------------------------------------------------------------
 *
 * Nothing in this repo renders a React component in a unit test -- there is no
 * @testing-library/react, and the other `.client.test.ts` files test extracted logic. And the
 * component cannot be reached from the browser suite either: the fixture ships demo audiences,
 * so `hasAudiences` is true on every Playwright project, `FirstAudiencePrompt` has never been
 * rendered by any test and axe has never seen it.
 *
 * So the decision was split out of the component, which is the same move `lib/settings-summary
 * .ts` made for the settings hub when its four lines turned out to be unreachable. The five
 * conditions were a numbered comment beside an inline `if`; they are a typed signature now,
 * and every branch of it is exercised below.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT PROVE, STATED SO IT IS NOT MISTAKEN FOR COVERAGE
 * ---------------------------------------------------------------------------
 *
 * That the five values arriving at the predicate are correct on a real account. Whether the
 * contact and group counts are scoped to the caller by RLS, and whether a real workspace
 * reaches `isOwner` the way the fixture does, are questions only the throwaway-account recipe
 * can answer. This file proves the rule; the release gate still owns the wire. Same shape as
 * the contact-name ingest bug, where fixture-only green was not evidence for a path the
 * fixture could not take.
 */

/*
 * DO NOT REWRITE THIS AS `new URL('../src/lib/first-run.ts', import.meta.url)`.
 *
 * Vite statically analyses `new URL('<string literal>', import.meta.url)` and rewrites it into
 * an ASSET url, so in the jsdom projects it evaluates to `http://localhost:3000/apps/web/src/
 * lib/first-run.ts` and `fileURLToPath` throws "The URL must be of scheme file". Measured, not
 * guessed: the same expression with the path in a VARIABLE is left alone and returns the
 * `file:///…` url, which is the only reason `passkey-ui.client.test.ts`'s `read(path)` helper
 * works while the obvious inline spelling does not. `import.meta.url` itself is `file:` in both
 * cases, so the base is never the problem and printing it tells you nothing.
 *
 * `fileURLToPath` on the STRING sidesteps the rewrite entirely, because there is no `new URL`
 * literal for Vite to match.
 */
const HERE = dirname(fileURLToPath(import.meta.url))

/** All five in the state that SHOWS the prompt, so each case below can falsify exactly one. */
const OFFERED = {
  armed: true,
  dismissed: false,
  isOwner: true,
  hasEvents: true,
  hasAudiences: false,
} as const

describe('the five conditions', () => {
  /*
   * The control. Without it every case below could pass against a predicate that always
   * returned false -- which is the failure mode a suite of negative assertions invites, and
   * the one the settings spec's "in the stated order" test actually shipped.
   */
  it('offers the prompt when all five agree', () => {
    expect(shouldOfferAudiencePrompt(OFFERED)).toBe(true)
  })

  it('stays silent until a first save has armed it', () => {
    // Not "the calendar has events": that would greet a month-old user with a beginner's hint.
    expect(shouldOfferAudiencePrompt({ ...OFFERED, armed: false })).toBe(false)
  })

  it('stays silent once dismissed', () => {
    expect(shouldOfferAudiencePrompt({ ...OFFERED, dismissed: true })).toBe(false)
  })

  it('never appears while previewing as somebody else', () => {
    // The calendar on screen is not yours to configure, so an invitation to configure it is
    // incoherent rather than merely untimely.
    expect(shouldOfferAudiencePrompt({ ...OFFERED, isOwner: false })).toBe(false)
  })

  it('never appears over a page with nothing on it', () => {
    // `armed` is durable and per-device; this is about the week actually in front of them.
    expect(shouldOfferAudiencePrompt({ ...OFFERED, hasEvents: false })).toBe(false)
  })

  it('retires the moment any contact or group exists', () => {
    expect(shouldOfferAudiencePrompt({ ...OFFERED, hasAudiences: true })).toBe(false)
  })

  it('needs every clause, so no single condition can carry it alone', () => {
    // Sweeps the same ground as the cases above, but as a property: flipping any one input
    // away from OFFERED must silence it. Catches a clause dropped in a refactor even if
    // somebody also deletes the case that named it.
    for (const key of Object.keys(OFFERED) as (keyof typeof OFFERED)[]) {
      expect(shouldOfferAudiencePrompt({ ...OFFERED, [key]: !OFFERED[key] })).toBe(false)
    }
  })
})

describe('the two remembered facts', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('both start false, so a fresh device shows nothing until something arms it', () => {
    expect(isFirstRunArmed()).toBe(false)
    expect(isAudiencePromptDismissed()).toBe(false)
    expect(
      shouldOfferAudiencePrompt({
        ...OFFERED,
        armed: isFirstRunArmed(),
        dismissed: isAudiencePromptDismissed(),
      }),
    ).toBe(false)
  })

  it('round-trips through storage and is idempotent', () => {
    armFirstRun()
    armFirstRun()
    expect(isFirstRunArmed()).toBe(true)

    dismissAudiencePrompt()
    dismissAudiencePrompt()
    expect(isAudiencePromptDismissed()).toBe(true)
  })

  it('exports NO way to clear either flag, which is what "retires and never returns" means', () => {
    /*
     * The module's own header promises no re-arm path -- no "show me again", no counter, no
     * reappearance after n days -- and the promise is only as good as the surface area. An
     * exported `clearFirstRun` would turn an onboarding hint into an onboarding obligation,
     * and it is exactly the helper somebody adds while writing a test for something else.
     *
     * SCANS THE SOURCE RATHER THAN THE IMPORTS. Listing the imported bindings and checking
     * their names would be blind by construction: a new export nobody imported here could not
     * appear in it, so the test would pass by not looking. Same reason `passkey-ui.client
     * .test.ts` reads its file off disk. `removeItem` and `localStorage.clear` are in the
     * pattern too -- a clearing helper does not have to be NAMED like one.
     */
    const source = readFileSync(join(HERE, '../src/lib/first-run.ts'), 'utf8')
    const exported = [...source.matchAll(/^export const (\w+)/gm)].map((m) => m[1] ?? '')

    expect(exported.length).toBeGreaterThan(0)
    /* ANCHORED AT THE START, because these names are verb-first and an unanchored alternation
       collides: `unarm` is a substring of `isFirstR(unarm)ed`, so the first spelling of this
       failed against a READER. Same family as the `getByRole` name-substring trap. */
    expect(exported.filter((name) => /^(clear|reset|unarm|rearm|undismiss|forget)/i.test(name))).toEqual([])
    expect(source).not.toMatch(/removeItem|localStorage\s*\.\s*clear/)
  })
})

describe('when storage itself throws', () => {
  /*
   * Safari in private mode and a browser with storage disabled both throw on ACCESS, not on
   * read. The right answer to "we cannot tell" is to show nothing: an invitation that cannot
   * record its own dismissal is one the user can never get rid of, which is worse than never
   * offering it. So both reads must fail CLOSED, and `dismissed` failing closed to `false`
   * only matters because `armed` fails closed to `false` too -- the conjunction is what makes
   * it safe, which is why this asserts the decision and not just the reads.
   */
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      },
    })
  })

  afterEach(() => {
    if (original !== undefined) Object.defineProperty(globalThis, 'localStorage', original)
    vi.restoreAllMocks()
  })

  it('reads false rather than propagating', () => {
    expect(isFirstRunArmed()).toBe(false)
    expect(isAudiencePromptDismissed()).toBe(false)
  })

  it('writes swallow the failure rather than erroring at somebody who just saved an event', () => {
    expect(() => armFirstRun()).not.toThrow()
    expect(() => dismissAudiencePrompt()).not.toThrow()
  })

  it('leaves the prompt hidden, not permanently stuck on screen', () => {
    expect(
      shouldOfferAudiencePrompt({
        ...OFFERED,
        armed: isFirstRunArmed(),
        dismissed: isAudiencePromptDismissed(),
      }),
    ).toBe(false)
  })
})
