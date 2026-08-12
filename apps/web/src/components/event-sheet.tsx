'use client'

import { useEffect, useId, useRef, type ReactNode } from 'react'
import { Button } from './ui/button'
import { InlineError } from './ui/inline-error'
import styles from './event-sheet.module.css'

/**
 * The modal shell every event sheet sits in. Shell only — it owns no form state and knows
 * nothing about events.
 *
 * WHY A NATIVE <dialog>. The markup this replaces carried `role="dialog"` and
 * `aria-modal="true"` while implementing none of what those promise: no focus trap, no
 * Escape handler, no focus restore, and the rest of the page left perfectly reachable behind
 * it. That is worse than an unlabelled dialog, because a screen reader is told the content
 * behind is unavailable when it is not. `showModal()` provides all four, plus the top layer
 * and `::backdrop`, with no focus-management code to get subtly wrong.
 *
 * Nobody noticed because the a11y suite never opens a sheet — `<NewEvent>` does not render
 * in fixture mode, so axe has never seen one. Worth fixing before a second sheet inherits it.
 *
 * MOUNTING IS OPENING. The parent renders this component only while the sheet should be
 * open, so there is no `open` prop to keep in sync with the DOM's own idea of openness —
 * a class of bug native <dialog> is particularly good at producing.
 */
export function EventSheet({
  title,
  error,
  busy = false,
  submitLabel,
  submitDisabled = false,
  cancelLabel = 'Cancel',
  onSubmit,
  onClose,
  children,
}: {
  title: string
  /** Shown above the fields, announced immediately. Null when there is nothing wrong. */
  error?: string | null
  /** Disables every control while a write is in flight. */
  busy?: boolean
  submitLabel: string
  submitDisabled?: boolean
  cancelLabel?: string
  onSubmit: (event: React.FormEvent) => void
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (dialog === null) return
    // Not `open={true}`: only showModal() puts the element in the top layer, and only the
    // top layer gives the focus trap, the backdrop and the inertness of everything behind.
    //
    // NO CLEANUP THAT CLOSES, and the guard is not defensive padding. React re-runs effects
    // in development (effect → cleanup → effect) to surface exactly this kind of bug, and
    // `dialog.close()` dispatches a `close` event — so a cleanup that closed would call
    // onClose and shut the sheet in the same tick it opened. It did, and only in dev, which
    // is the worst place for a bug to live. Unmounting removes the element from the DOM,
    // which releases the top layer on its own; the guard makes the second showModal() a
    // no-op instead of an InvalidStateError.
    if (!dialog.open) dialog.showModal()
  }, [])

  return (
    <dialog
      ref={ref}
      className={styles.sheet}
      aria-labelledby={titleId}
      aria-busy={busy || undefined}
      // Escape fires `cancel`, then `close`. Both are routed to the same place so the parent
      // has exactly one way to learn the sheet went away, whatever dismissed it.
      onCancel={(event) => {
        // A write in flight should not be abandoned halfway by a stray keypress.
        if (busy) event.preventDefault()
      }}
      onClose={onClose}
    >
      <form className={styles.body} onSubmit={onSubmit}>
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>

        <InlineError>{error}</InlineError>

        {children}

        <div className={styles.actions}>
          {/* Cancel first, so the destructive-in-effect button is never where the thumb
              already is after the last field. Cancel is disabled while busy but is never
              itself "in progress" — only Save gets the busy cursor. */}
          <Button variant="outline" disabled={busy} onClick={() => ref.current?.close()}>
            {cancelLabel}
          </Button>
          <Button
            type="submit"
            variant="primary"
            className={styles.grow}
            busy={busy}
            disabled={submitDisabled}
          >
            {submitLabel}
          </Button>
        </div>
      </form>
    </dialog>
  )
}
