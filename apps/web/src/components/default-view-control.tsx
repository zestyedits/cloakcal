'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { rpcErrorMessage } from '@/lib/rpc-error'
import { canSavePrefs, saveCalendarPrefs, type PrefsTarget } from '@/lib/save-prefs'
import type { CalendarViewPref } from '@/server/settings'
import { Button } from './ui/button'
import { InlineError } from './ui/inline-error'
import styles from './default-view-control.module.css'

/**
 * "Make this my default view", where you already are.
 *
 * The preference has existed since migration 0022 and was effectively invisible: it lived
 * as a select labelled "Opens on", third inside a card called Time & region that is closed
 * by default, on a page you have to go to. Someone who wants their calendar to open on
 * Month is, by definition, standing on Month when they think of it — so the control
 * belongs there too. Settings keeps its copy (renamed to "Default view"), because a
 * preference should also be findable in the place preferences live.
 *
 * Two states, and the satisfied one is deliberately NOT a disabled button: a control that
 * cannot be pressed invites you to work out why. A sentence says the thing instead.
 *
 * Hidden entirely when there is nowhere to save — a signed-in user with no workspace yet,
 * or a restricted audience previewing someone else's calendar (that is not their setting
 * to make). The demo can save, to a cookie, which is the whole point of it being demoable.
 */
export function DefaultViewControl({
  current,
  defaultView,
  target,
}: {
  /** The view on screen right now. */
  current: CalendarViewPref
  /** The stored preference. */
  defaultView: CalendarViewPref
  target: PrefsTarget
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!canSavePrefs(target)) return null

  const label = VIEW_LABELS[current]

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await saveCalendarPrefs(target, { defaultView: current })
      router.refresh()
    } catch (caught) {
      setError(rpcErrorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  if (current === defaultView) {
    return (
      <p className={styles.settled}>
        <span className={styles.tick} aria-hidden="true">
          ✓
        </span>
        {label} is your default view
      </p>
    )
  }

  return (
    <div className={styles.control}>
      <Button variant="ghost" size="sm" busy={busy} onClick={() => void save()}>
        Make {label} my default view
      </Button>
      <InlineError>{error}</InlineError>
    </div>
  )
}

const VIEW_LABELS: Record<CalendarViewPref, string> = {
  agenda: 'Agenda',
  week: 'Week',
  day: 'Day',
  month: 'Month',
}
