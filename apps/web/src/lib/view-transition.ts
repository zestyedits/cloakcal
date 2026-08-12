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
