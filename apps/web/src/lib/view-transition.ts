'use client'

import { flushSync } from 'react-dom'

/**
 * Run a state update inside a View Transition when the browser has one, instantly when it
 * does not.
 *
 * This is `document.startViewTransition`, NOT Next's experimental `viewTransition` flag:
 * that flag integrates with route changes on an experimental React channel, and the thing
 * being animated here (agenda ↔ week) is client `useState` inside one page. The native API
 * is stable in Chromium and recent Safari; Firefox and older engines take the `update()`
 * branch below, which is the app's exact pre-animation behaviour — so the fallback is not
 * a degraded mode, it is what shipped last week.
 *
 * `flushSync` is required, not decoration: the browser snapshots the old frame, runs the
 * callback, and snapshots the new frame. If React batches the update past the callback,
 * the "new" snapshot is identical to the old one and the transition animates nothing.
 *
 * Reduced motion is checked here rather than in CSS because the transition's default
 * cross-fade is injected by the browser, not authored in our stylesheet where the token
 * collapse could reach it.
 *
 * SERVER navigations (steppers, day/month switches, cross-page links) deliberately get
 * NO View Transition, in either of the forms available on Next 15.5, and the reasons
 * are worth keeping:
 *
 * - `experimental.viewTransition` is not a nav-polish flag. Next lists it in
 *   needs-experimental-react() beside ppr and taint, so turning it on swaps the ENTIRE
 *   app onto the experimental React channel runtime (app-page-experimental.runtime).
 *   Moving a shipping privacy product's whole React build onto an experimental channel
 *   to cross-fade a page turn is a trade with one small upside and unbounded downside.
 *
 * - Hand-rolling it — startViewTransition around router.push, resolving when the route
 *   commits — snapshots the old frame and holds it, frozen and inert, until the server
 *   answers. On a force-dynamic app that is the entire round trip: it would REPLACE the
 *   pending feedback (ui/nav-pending.tsx) with a screenshot that ignores the user, which
 *   is the exact perceived-latency failure this module's callers exist to avoid. A
 *   cross-fade is worth 200ms of theatre only when the next frame is already in hand,
 *   which for the client toggle below it is.
 *
 * Revisit at the Next 16 upgrade if the flag leaves the experimental-React bucket.
 */
export function withViewTransition(update: () => void): void {
  if (
    typeof document === 'undefined' ||
    !('startViewTransition' in document) ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    update()
    return
  }

  ;(
    document as Document & { startViewTransition: (callback: () => void) => unknown }
  ).startViewTransition(() => {
    flushSync(update)
  })
}
