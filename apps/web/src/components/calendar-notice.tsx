'use client'

import type { ReactNode } from 'react'
import { Button } from './ui/button'
import styles from './calendar-notice.module.css'

/**
 * The result strip — what the calendar says after it has done something.
 *
 * WHY THIS IS NOT A TOAST, stated once here because the pull toward one is constant. A toast
 * dismisses itself on a timer, which budgets a user's attention against a wall clock: the
 * same class of mistake as budgeting a test's observation window against one, which this repo
 * has already paid for in nav-feel.spec.ts. Somebody reading slowly, or looking away, or using
 * a screen reader that queues announcements, loses the message and any action attached to it.
 *
 * So this is persistent and dismissible, and it lives IN the surface it is about rather than
 * floating over a corner of the viewport. `--z-toast` stays the offline banner's.
 *
 * It is also deliberately not a success colour, not an icon and not an animation. The RESULT
 * is the confirmation — the row that now exists, the event that is now gone — and this line
 * only names what happened and where. A privacy instrument does not celebrate.
 *
 * `role="status"` rather than `alert`: a completed action is not an error, and `alert`
 * interrupts. The one caller that also moves focus (the undo path, for a keyboard-initiated
 * delete) does so itself; announcing and focusing are different decisions and are made in
 * different places on purpose.
 */
export function CalendarNotice({
  children,
  action,
  onDismiss,
}: {
  children: ReactNode
  /** The one thing you might want to do about it — Undo, or a door to where it went. */
  action?: ReactNode
  onDismiss: () => void
}) {
  return (
    <div className={styles.notice} role="status">
      <p className={styles.text}>{children}</p>
      {action}
      <Button
        variant="ghost"
        size="sm"
        className={styles.dismiss}
        // A real label, not an "x": the control has to say what it does, and a bare glyph in
        // a status region reads as decoration to anything that is not a pointer.
        onClick={onDismiss}
      >
        Dismiss
      </Button>
    </div>
  )
}
