import type { Route } from 'next'

/**
 * THE four doors of /settings — id, label, href and order — in one copy, for three
 * consumers: the hub, the hub's loading fallback, and the sibling list at the foot of every
 * settings sub-page.
 *
 * IT HAS TO LIVE HERE, and the reason has not changed with the restructure. A server
 * component that imports a non-component value from a `'use client'` module does not get
 * the value, it gets a client-reference proxy, and `.map is not a function` thrown inside a
 * Suspense fallback renders as a DOUBLED PAGE rather than as an error: two `<h1>`s, two
 * `<main>`s, ten `<details>` where five belonged. Exactly the shape and exactly the
 * reasoning of `lib/calendar-views.ts`.
 *
 * Seven accordion sections became four doors. Four of the seven had already decayed into a
 * paragraph and a link — People, Availability, Security and Plan held no controls at all —
 * so this finishes a migration that was half done rather than starting a new one. What went
 * with the accordion: a scroll-spy rail, a numbered index that failed AA in the light theme,
 * a hash-to-open effect, and sixty lines of code that watched the document stop moving
 * before it dared scroll. None of that has a job on a page of links.
 *
 * The hub answers one question — what is true about my account right now, and what can I
 * change safely. Privacy is first because it is the product.
 */
export type SettingsDoorId = 'privacy' | 'calendar' | 'security' | 'plan'

export interface SettingsDoor {
  readonly id: SettingsDoorId
  readonly label: string
  /**
   * AN INLINE LITERAL, ALWAYS. `pnpm typecheck` does not see typedRoutes — the route union
   * is generated during `next build` — so an href moved behind a computation typechecks
   * green and then fails the build with "Argument of type 'string' is not assignable to
   * parameter of type 'RouteImpl<string>'". If one of these ever needs computing, use the
   * single-cast pattern `lib/audiences.ts` documents, not a template literal per call site.
   */
  readonly href: Route
  /** What the door is FOR: the middle of the three levels a hub row gives the eye. */
  readonly description: string
  /**
   * Whether the door renders at all.
   *
   * A STATIC LIST CANNOT ASK `billingEnabled()`. That reads `process.env` on the server, and
   * this module is also the source for a fallback's skeleton rows. So the condition is DATA
   * here and the caller resolves it through `visibleDoors()`, which means the page and its
   * `loading.tsx` call the identical function and cannot disagree about how many rows exist.
   * A skeleton of four settling to three is a visible jump on the one page whose fallback
   * was hand-built to avoid exactly that.
   */
  readonly gate: 'always' | 'billing'
  /**
   * The summary line when there is no real fact to state: the demo, or a signed-in account
   * with no workspace row yet. Never a guess dressed as a reading.
   */
  readonly pending: string
}

export const SETTINGS_DOORS = [
  {
    id: 'privacy',
    label: 'Privacy',
    href: '/settings/privacy',
    description: 'What each person and group sees by default, and who those people are.',
    gate: 'always',
    pending: 'Nobody yet',
  },
  {
    id: 'calendar',
    label: 'Calendar',
    href: '/settings/calendar',
    description: 'Your calendars, your timezone, how it looks, and the hours you are open.',
    gate: 'always',
    pending: 'Not set up yet',
  },
  {
    id: 'security',
    label: 'Security & data',
    href: '/settings/security',
    // Named for both halves on purpose. Export and the deletion route live here now, and a
    // door called only "Security" is one nobody opens looking for their own data.
    description:
      'Password, passkeys, recovery phrase, the devices that can open your calendar, and getting your data out.',
    gate: 'always',
    pending: 'Password and recovery phrase',
  },
  {
    id: 'plan',
    label: 'Billing',
    href: '/settings/plan',
    // "Billing", not "Plan". The door only exists when there is something to buy or manage,
    // so it is named for the act rather than for the tier.
    description: 'What you are on, what it costs, and the card on file.',
    gate: 'billing',
    pending: 'Demo',
  },
] as const satisfies readonly SettingsDoor[]

/**
 * The summary line for every door, keyed by id.
 *
 * TOTAL, not Partial, and that is the compile-time link between this list and the loader:
 * adding a door makes the summary loader fail to typecheck until it produces a line for it.
 * Same instinct as `billingFailure`'s parameter type — an invented case is a compile error
 * rather than a row that silently prints nothing.
 */
export type SettingsSummary = Readonly<Record<SettingsDoorId, string>>

/**
 * The doors this request should draw. Billing is the only conditional one, and its
 * condition is resolved by the caller so that a server page and its fallback can agree.
 */
export function visibleDoors(billingEnabled: boolean): readonly SettingsDoor[] {
  return SETTINGS_DOORS.filter((door) => door.gate === 'always' || billingEnabled)
}

/**
 * The seven ids /settings used to anchor, and where each one went.
 *
 * A HASH NEVER REACHES THE SERVER. It is not in the request line, so this cannot be a
 * middleware rule, a `redirects()` entry in next.config, or anything on the route — it is
 * read on the client by `legacy-hash-forward.tsx`. Links inside this repo are repointed at
 * the real routes directly and do not go through here at all; this exists for bookmarks,
 * for `/account`'s old destination, and for anything already sent out in an email.
 *
 * `settings-legacy-hashes.server.test.ts` asserts every target names a route that exists,
 * so deleting a page cannot leave a forwarder pointing at a 404.
 */
export const LEGACY_SETTINGS_HASHES: Readonly<Record<string, Route>> = {
  appearance: '/settings/calendar',
  'time-region': '/settings/calendar',
  calendars: '/settings/calendar',
  sharing: '/settings/privacy',
  availability: '/settings/availability',
  security: '/settings/security',
  plan: '/settings/plan',
}
