'use client'

import { useEffect, useState } from 'react'
import { useLinkStatus } from 'next/link'

import progress from './route-progress.module.css'

/**
 * The marker half of navigation acknowledgment.
 *
 * A server navigation on a force-dynamic app spends its whole round trip on the wire,
 * and until 2026-08 nothing on screen admitted it: a stepper click changed NOTHING for
 * ~300ms against a fast server (measured on the fixture with a 200ms latency model) and
 * for however long Supabase takes in production. The click looked ignored, which reads
 * as "slow" long before it is.
 *
 * This renders inside a <Link> (useLinkStatus reads the surrounding link's context) and
 * mounts an empty hidden span carrying `data-nav-pending` while that link's navigation
 * is in flight. The visible half is CSS: the control styles itself through
 * `:has([data-nav-pending])` with the same wash its :hover already wears — a held press,
 * not a new visual grammar, and no new CONTRAST_PAIRS entries because every wash/ink
 * pair here is one a recorded hover state already uses. A child marker styling its
 * parent is deliberate: pending is the LINK's state, and only the link knows it.
 *
 * Deliberately not motion. The wash appears at once and holds until the route commits,
 * so reduced motion changes nothing and no animation event is load-bearing — the
 * tokens.css collapse cannot reach a state that was never animated. Browsers without
 * :has() simply keep the old behaviour; the cue is an acknowledgment, not a control.
 *
 * ---------------------------------------------------------------------------
 * AND THE SECOND HALF, ADDED WHEN THE LOADING FALLBACKS WERE REMOVED
 * ---------------------------------------------------------------------------
 *
 * No route draws a skeleton any more: a navigation now shows the OUTGOING page, fully
 * painted and with its pressed state held, until the destination is ready to commit
 * atomically. That is the whole point of the change, and it leaves one gap — a genuinely
 * slow route would offer nothing beyond a held press.
 *
 * So this also owns a hairline at the top of the viewport, and owns it HERE rather than in
 * its own component so that every one of the ~10 links already carrying this marker gets it
 * without a second hook and a second call site to keep in step.
 *
 * IT WAITS 150ms FIRST. A bar that appears instantly flashes for 40ms on a fast navigation,
 * which reads as a glitch rather than as progress and pulls the eye exactly when nothing
 * needed it. Anything that resolves inside the window is simply instant.
 *
 * It is not a skeleton and must never become one: no reserved space, no flow, no shape a
 * real element could be mistaken for. The ghost-wireframe problem this pass removed comes
 * straight back the moment a progress indicator starts implying structure.
 */
export function NavPendingMark() {
  const { pending } = useLinkStatus()
  const [slow, setSlow] = useState(false)

  useEffect(() => {
    if (!pending) {
      setSlow(false)
      return
    }
    const timer = setTimeout(() => setSlow(true), 150)
    return () => clearTimeout(timer)
  }, [pending])

  if (!pending) return null
  return (
    <>
      <span data-nav-pending="" hidden aria-hidden="true" />
      {/* aria-hidden: the tapped control already carries the state a screen reader needs,
          and announcing every navigation would be noise on the most predictable
          interaction in the product. */}
      {slow ? <span className={progress.line} aria-hidden="true" /> : null}
    </>
  )
}
