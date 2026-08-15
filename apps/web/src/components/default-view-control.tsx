'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { rpcErrorMessage } from '@/lib/rpc-error'
import { canSavePrefs, saveCalendarPrefs, type PrefsTarget } from '@/lib/save-prefs'
import { VIEW_LABELS } from '@/lib/calendar-views'
import type { CalendarView } from './calendar-screen'
import { Button } from './ui/button'
import { InlineError } from './ui/inline-error'
import styles from './default-view-control.module.css'

/**
 * "Open on this view" — a bookmark that lives INSIDE the segmented view control.
 *
 * The preference has existed since migration 0022 and was effectively invisible: a select
 * labelled "Opens on", third inside a card called Time & region that is closed by default,
 * on a page you have to go to. Someone who wants their calendar to open on Month is, by
 * definition, standing on Month when they think of it — so the control belongs there, in
 * the same sunken track as the views themselves rather than as another box beside them.
 *
 * TWO PRESENTATIONS, ONE BEHAVIOUR, because the chrome splits by device exactly as
 * everything else here does. `segment` is the bookmark in the desktop header's track.
 * `row` is the phone's, in the sidebar strip that survives at small widths — the bottom
 * bar has five fixed slots and no room for a sixth, and a preference does not outrank a
 * view. Each is hidden at the other's breakpoint by CSS, so only one is ever on screen.
 *
 * Already-the-default renders `aria-disabled` rather than gone or plain-disabled: a
 * control that vanishes shifts the track's width every time you switch view, and a control
 * that is merely disabled makes people hunt for the reason. Disabled-with-the-reason-in-
 * the-label states the fact and stays put.
 *
 * Hidden entirely when there is nowhere to save — a signed-in user with no workspace yet,
 * or a restricted audience previewing someone else's calendar, which is not their setting
 * to make. The demo saves to a cookie, which is the whole point of it being demoable.
 */
export function DefaultViewControl({
  current,
  defaultView,
  target,
  variant,
}: {
  /** The view on screen right now. */
  current: CalendarView
  /** The stored preference. */
  defaultView: CalendarView
  target: PrefsTarget
  variant: 'segment' | 'row'
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!canSavePrefs(target)) return null

  const label = VIEW_LABELS[current]
  const isDefault = current === defaultView

  const save = async () => {
    if (isDefault) return
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

  const description = isDefault
    ? `${label} is your default view`
    : `Make ${label} my default view`

  if (variant === 'segment') {
    return (
      <button
        type="button"
        className={styles.pin}
        aria-pressed={isDefault}
        aria-disabled={isDefault || busy || undefined}
        aria-label={description}
        title={description}
        data-pinned={isDefault || undefined}
        onClick={() => void save()}
      >
        <BookmarkMark filled={isDefault} />
      </button>
    )
  }

  return (
    <div className={styles.control}>
      <Button
        variant="ghost"
        size="sm"
        busy={busy}
        aria-pressed={isDefault}
        aria-disabled={isDefault || undefined}
        onClick={() => void save()}
      >
        <BookmarkMark filled={isDefault} />
        {description}
      </Button>
      <InlineError>{error}</InlineError>
    </div>
  )
}

/**
 * A bookmark, filled when this view is the one the calendar opens on.
 *
 * Filled-vs-outline is a SHAPE change, not a colour one, so the state survives both themes
 * and does not lean on a hue anyone has to distinguish — the same reason the calendar
 * swatches carry a check rather than relying on their colour alone.
 */
function BookmarkMark({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M4.25 2.75h7.5v10.5L8 10.5l-3.75 2.75z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}
