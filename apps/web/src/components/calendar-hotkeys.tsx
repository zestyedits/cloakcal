'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { stepQuery, todayQuery } from '@/lib/calendar-links'
import { useCloakStore } from './cloak-provider'
import type { CalendarView } from './calendar-screen'
import styles from './calendar-hotkeys.module.css'

/**
 * Keyboard navigation for the calendar: the bindings every calendar user already knows.
 *
 *   t              today               1 / 2 / 3 / 4   agenda / week / day / month
 *   ← / k          previous period     n               new event
 *   → / j          next period         ?               this list
 *
 * SINGLE KEYS, DELIBERATELY. Google Calendar and Fastmail trained everyone on
 * modifier-free shortcuts, and modifier chords collide with browser and screen-reader
 * bindings. The guards below satisfy WCAG 2.1.4's "inactive in text entry" condition;
 * a Settings toggle to turn them off entirely is the recorded remaining gap, not a
 * claimed conformance.
 *
 * THE GUARD ORDER IS THE CONTRACT: an already-handled event, any modifier, IME
 * composition, focus inside text entry, or ANY open dialog (every sheet in the app is a
 * native <dialog>) all mean the key is not ours. The dialog guard is also what turns the
 * help overlay itself off while it is open.
 *
 * Navigation goes through the same query builders as every link (calendar-links.ts), so
 * redaction stays on the server and nothing decrypted can enter a URL from here.
 */
export function CalendarHotkeys({
  view,
  anchorDate,
  audience,
  composeAvailable,
  onSelectView,
  onCompose,
}: {
  view: CalendarView
  anchorDate: string | undefined
  audience: string
  /** False in fixture mode and for non-owners; `n` is silently inert then. */
  composeAvailable: boolean
  /** The screen's own switch semantics: instant toggle on the week fetch, link otherwise. */
  onSelectView: (target: CalendarView) => void
  onCompose: () => void
}) {
  const router = useRouter()
  const store = useCloakStore()
  const [helpOpen, setHelpOpen] = useState(false)

  // A ref so the listener reads current values without re-binding every render.
  const current = useRef({ view, anchorDate, audience, composeAvailable })
  current.current = { view, anchorDate, audience, composeAvailable }
  const callbacks = useRef({ onSelectView, onCompose })
  callbacks.current = { onSelectView, onCompose }
  const unlocked = store !== null && store.isUnlocked
  const unlockedRef = useRef(unlocked)
  unlockedRef.current = unlocked

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.isComposing) return
      const target = event.target
      if (
        target instanceof Element &&
        target.closest('input, textarea, select, [contenteditable]') !== null
      ) {
        return
      }
      if (document.querySelector('dialog[open]') !== null) return

      const { view, anchorDate, audience, composeAvailable } = current.current

      const go = (query: Record<string, string>) => {
        const params = new URLSearchParams(query)
        router.push(params.size > 0 ? `/?${params.toString()}` : '/')
      }
      const step = (n: number) => {
        if (anchorDate !== undefined) go(stepQuery(anchorDate, view, n, audience))
      }
      const views: Record<string, CalendarView> = {
        '1': 'agenda',
        '2': 'week',
        '3': 'day',
        '4': 'month',
      }

      switch (event.key) {
        case 't':
        case 'T':
          event.preventDefault()
          go(todayQuery(view, audience))
          return
        case 'ArrowLeft':
        case 'k':
          event.preventDefault()
          step(-1)
          return
        case 'ArrowRight':
        case 'j':
          event.preventDefault()
          step(1)
          return
        case '1':
        case '2':
        case '3':
        case '4':
          event.preventDefault()
          callbacks.current.onSelectView(views[event.key]!)
          return
        case 'n':
          // Silently inert when compose is unavailable or the store is locked — the
          // keyboard equivalent of the disabled New event button.
          if (composeAvailable && unlockedRef.current) {
            event.preventDefault()
            callbacks.current.onCompose()
          }
          return
        case '?':
          event.preventDefault()
          setHelpOpen(true)
          return
        default:
          return
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [router])

  return helpOpen ? <HotkeyHelp onClose={() => setHelpOpen(false)} /> : null
}

const BINDINGS: ReadonlyArray<readonly [keys: string, action: string]> = [
  ['t', 'Today'],
  ['← or k', 'Previous period'],
  ['→ or j', 'Next period'],
  ['1', 'Agenda'],
  ['2', 'Week'],
  ['3', 'Day'],
  ['4', 'Month'],
  ['n', 'New event'],
  ['?', 'This list'],
]

function HotkeyHelp({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)

  // Mounting is opening. NO close() in the cleanup: dev-mode effect re-runs would
  // dispatch a close event and shut the dialog the instant it opens (the documented
  // event-sheet trap). Unmounting releases the top layer on its own.
  useEffect(() => {
    ref.current?.showModal()
  }, [])

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby="hotkey-help-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose()
      }}
    >
      <h2 id="hotkey-help-title" className={styles.title}>
        Keyboard shortcuts
      </h2>
      <dl className={styles.list}>
        {BINDINGS.map(([keys, action]) => (
          <div key={keys} className={styles.row}>
            <dt className={styles.keys}>
              <kbd>{keys}</kbd>
            </dt>
            <dd className={styles.action}>{action}</dd>
          </div>
        ))}
      </dl>
      <p className={styles.note}>Shortcuts are ignored while you are typing.</p>
      <button type="button" className={styles.close} onClick={onClose}>
        Close
      </button>
    </dialog>
  )
}
