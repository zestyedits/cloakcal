'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { audienceHref } from '@/lib/audiences'
import styles from './audience-transition.module.css'

/**
 * The cloak, on the surface it is actually about.
 *
 * `--duration-cloak` has existed since M0 as "the signature motion" and was spent entirely on
 * cloaked-text.module.css's per-VALUE uncloak wipe. The audience switch — the product's whole
 * argument — had no motion of its own at all: it reused the generic `rise` stagger through
 * `<ol key={page.audience}>`, which is the same entrance any navigation plays. The landing
 * page had a real reseal and the product did not.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A VIEW TRANSITION, AND WHY THAT REFUSAL STANDS
 * ---------------------------------------------------------------------------
 *
 * The obvious implementation is `document.startViewTransition` around the `router.push`.
 * lib/view-transition.ts already argues against exactly that and is right: every route here is
 * force-dynamic, so the browser would snapshot the old frame and hold it, frozen and inert,
 * for the ENTIRE round trip — replacing live acknowledgment with a screenshot that ignores
 * the user. A cross-fade is worth its cost only when the next frame is already in hand, and
 * across an audience switch it never is.
 *
 * So this is a different mechanism: an OUTGOING gesture fired at click time that overlaps the
 * fetch. It costs zero added latency, because the fetch is longer than the animation anyway.
 *
 * ---------------------------------------------------------------------------
 * THE COVER IS OPAQUE, AND THAT IS CORRECTNESS RATHER THAN STYLE
 * ---------------------------------------------------------------------------
 *
 * The first draft of this settled at `opacity: 0.5; filter: blur(2px)` and that was wrong in
 * the one way this product cannot afford. BLUR IS NOT REDACTION. A 2px blur leaves a title
 * substantially legible, and it does nothing whatsoever to the accessibility tree — the full
 * owner-level text stays in the DOM, readable by any screen reader, for the whole fetch, while
 * the frame that is about to arrive says "Previewing as Priya".
 *
 * So the cover is an OPAQUE plate in --surface-base and the stale subtree is marked `inert` at
 * the same instant, which per the HTML spec takes it out of the accessibility tree as well as
 * out of focus order (see SealableMain for why `aria-hidden` is NOT stacked on top of it).
 * Reduced motion loses the WIPE and keeps the COVER:
 * the tokens collapse --duration-cloak to 1ms, so the plate simply appears. The correctness
 * half was never an animation.
 *
 * ---------------------------------------------------------------------------
 * DIRECTION IS THE MEANING
 * ---------------------------------------------------------------------------
 *
 * Narrowing (to anyone who is not you) covers. Widening (back to your own view) does NOT:
 * showing LESS than you are entitled to is never a disclosure error, so the restricted view
 * is retained until the fuller one arrives and then reveals through CloakedText's existing
 * uncloak. Closing must hide immediately; opening may wait. That asymmetry is the point, and
 * it is why widening still gets a pending line rather than nothing at all.
 *
 * A lateral switch — one contact to another — counts as narrowing, because nothing here can
 * know whether the new audience sees more or less than the old one and covering is the safe
 * answer to a question we cannot answer.
 */

interface Sealing {
  /** The sentence, already built. Announced by the cover or by the pending line. */
  readonly label: string
  /** True to draw the opaque plate; false is the widening case, which retains. */
  readonly cover: boolean
}

interface AudienceTransition {
  readonly sealing: Sealing | null
  /** `label` is the already-decrypted audience name; owner passes anything. */
  readonly switchTo: (audienceId: string, label: string) => void
}

const Context = createContext<AudienceTransition | null>(null)

export function AudienceTransitionProvider({ children }: { children: ReactNode }) {
  const router = useRouter()
  const params = useSearchParams()
  const query = params.toString()
  const [sealing, setSealing] = useState<Sealing | null>(null)

  /**
   * THE RELEASE, and it is the URL rather than a timer.
   *
   * A wall-clock cap would be a guess about how long a server owes us, which is the mistake
   * this repo has already paid for in nav-feel.spec.ts. The query string changing IS the
   * navigation committing, so the cover holds exactly as long as the fetch and not a frame
   * longer. Depending on the STRING, not on the params object: `useSearchParams()` has no
   * documented referential stability, and an unstable identity in a dependency array is the
   * unbounded-effect-loop trap CloakProvider.extraFields already cost this project a day of
   * bisecting.
   */
  useEffect(() => {
    setSealing(null)
  }, [query])

  const switchTo = useCallback(
    (audienceId: string, label: string) => {
      const href = audienceHref(query, audienceId)
      // Switching to the audience already on screen would push the same URL, so `query` would
      // never change and the release above would never fire — a permanently covered calendar.
      // The comparison has to rebuild the current URL the same way audienceHref does.
      const current = query === '' ? '/' : `/?${query}`
      if (href === current) return

      const cover = audienceId !== 'owner'
      setSealing({
        cover,
        label: cover ? `Changing view to ${label}.` : 'Changing view to your own.',
      })
      router.push(href)
    },
    [query, router],
  )

  const value = useMemo<AudienceTransition>(() => ({ sealing, switchTo }), [sealing, switchTo])

  return <Context.Provider value={value}>{children}</Context.Provider>
}

/**
 * The one door into an audience change.
 *
 * Three surfaces switch audience — the sidebar picker, the preview bar's way out, and the
 * Cloak sheet's rows — and before this they each called `router.push(audienceHref(...))`
 * themselves. Three copies of one gesture is how the Today-from-Week bug happened; a fourth
 * that forgot to seal would silently reintroduce the disclosure gap this module exists to
 * close.
 *
 * Returns a no-op switch outside a provider rather than throwing: `ViewAsBar` renders inside
 * the Cloak sheet as well as the sidebar, and a hook that throws would make the composition
 * fragile for no safety gained.
 */
export function useAudienceSwitch(): AudienceTransition {
  return useContext(Context) ?? NO_TRANSITION
}

const NO_TRANSITION: AudienceTransition = Object.freeze({
  sealing: null,
  switchTo: () => {},
})

/**
 * The plate itself, rendered as a GRID CHILD in the same area as `<main>`.
 *
 * Grid items sharing an area overlap and later DOM order paints on top, so this needs no
 * absolute positioning, no measured offsets and nothing that could drift out of step with the
 * shell's two layouts (stacked on a phone, two-column from 900px). It covers exactly the
 * content area, in both.
 *
 * WHAT IS DELIBERATELY NOT COVERED, stated rather than left to be discovered: the sidebar.
 * Its calendar list IS redacted per audience, so it is stale for the same instant — but it
 * also holds the picker the user just used, and covering the control someone is mid-thought
 * with reads as the app seizing rather than responding. The trade is explicit: `<main>` holds
 * every title, time, chip and the preview bar's claim, and that is what must not be left
 * standing; a container's NAME is a materially weaker surface than the events inside it.
 */
export function AudienceCover() {
  const { sealing } = useAudienceSwitch()
  if (sealing === null || !sealing.cover) return null

  return (
    <div className={styles.cover} role="status">
      <p className={styles.label}>{sealing.label}</p>
    </div>
  )
}

/**
 * `<main>`, marked inert while the cover is over it.
 *
 * A component rather than an attribute in calendar-screen.tsx for a boring, load-bearing
 * reason: CalendarScreen RENDERS the provider, so its own hooks run OUTSIDE it and
 * `useAudienceSwitch()` there would always return the no-op. Exactly the constraint that put
 * EditableEvent in its own file rather than inline in the screen.
 *
 * `inert` ALONE, and deliberately not `inert` plus `aria-hidden`. Per the HTML spec an inert
 * subtree is removed from the accessibility tree AND unfocusable AND untargetable by pointer
 * events, so it is strictly stronger than aria-hidden, which only does the first. Stacking
 * both on invites a false `aria-hidden-focus` finding from axe, which does not uniformly
 * reason about inert — a red run that says nothing true. One correct mechanism beats a
 * correct one wearing a redundant one that trips the checker.
 */
export function SealableMain({
  className,
  children,
}: {
  className: string | undefined
  children: ReactNode
}) {
  const { sealing } = useAudienceSwitch()
  const sealed = sealing !== null && sealing.cover

  return (
    <main id="main" className={className} inert={sealed}>
      {children}
    </main>
  )
}

/**
 * The widening case's acknowledgment: a line, not a plate.
 *
 * Rendered inside `<main>` above the retained content. It exists because "no cover" must not
 * mean "no feedback" — the user asked for something and is waiting on a server, and the
 * restricted view they are still looking at is indistinguishable from one that simply did not
 * respond.
 */
export function AudienceWidening() {
  const { sealing } = useAudienceSwitch()
  if (sealing === null || sealing.cover) return null

  return (
    <p className={styles.widening} role="status">
      {sealing.label}
    </p>
  )
}
