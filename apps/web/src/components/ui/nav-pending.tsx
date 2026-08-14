'use client'

import { useLinkStatus } from 'next/link'

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
 */
export function NavPendingMark() {
  const { pending } = useLinkStatus()
  return pending ? <span data-nav-pending="" hidden aria-hidden="true" /> : null
}
