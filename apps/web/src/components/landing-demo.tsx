'use client'

import { useEffect, useRef, useState } from 'react'
import { PrivacyChip } from './ui/privacy-chip'
import styles from './landing.module.css'

/**
 * The hero demo: one event, three audiences, three different amounts. This is the pitch
 * drawn instead of described, and it uses the product's real pieces: the PrivacyChip and
 * the uncloak wipe vocabulary (landing.module.css repeats the keyframes from
 * cloaked-text.module.css, driven by the same --duration-cloak).
 *
 * THE TIME NEVER CHANGES. That cell is rendered once, outside the re-keyed region, so it
 * cannot even replay its animation. It is rule 1 drawn: the server keeps times readable,
 * and no audience setting hides them. The caption underneath says so in words.
 *
 * Content is invented static strings. Nothing here touches crypto, keys, or real data;
 * the component exists so a visitor with no account can watch redaction happen.
 *
 * Auto-advance is polite by design: it runs only while the demo is on screen, only when
 * the visitor has not chosen a tab, not while hovered or focused, never under reduced
 * motion, and it stops for good after three full loops (WCAG 2.2.2: the tabs remain as
 * the manual control, so nothing is lost when it stops).
 */

type Audience = 'you' | 'client' | 'everyone'

const ORDER: readonly Audience[] = ['you', 'client', 'everyone']

const TABS: Record<Audience, string> = {
  you: 'You',
  client: 'Your client',
  everyone: 'Everyone else',
}

const HOLD_MS = 3200
const MAX_LOOPS = 3

export function LandingDemo() {
  const [audience, setAudience] = useState<Audience>('you')
  const [chosen, setChosen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const restRef = useRef({ hovered: false, focused: false, visible: false, ticks: 0 })

  useEffect(() => {
    if (chosen) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const root = rootRef.current
    if (root === null) return

    const rest = restRef.current
    const observer = new IntersectionObserver(([entry]) => {
      rest.visible = entry?.isIntersecting ?? false
    })
    observer.observe(root)

    const interval = window.setInterval(() => {
      if (!rest.visible || rest.hovered || rest.focused) return
      if (rest.ticks >= MAX_LOOPS * ORDER.length) {
        window.clearInterval(interval)
        return
      }
      rest.ticks += 1
      setAudience((current) => ORDER[(ORDER.indexOf(current) + 1) % ORDER.length]!)
    }, HOLD_MS)

    return () => {
      observer.disconnect()
      window.clearInterval(interval)
    }
  }, [chosen])

  const choose = (next: Audience) => {
    setChosen(true)
    setAudience(next)
  }

  return (
    <div
      ref={rootRef}
      className={styles.demo}
      onMouseEnter={() => (restRef.current.hovered = true)}
      onMouseLeave={() => (restRef.current.hovered = false)}
      onFocus={() => (restRef.current.focused = true)}
      onBlur={() => (restRef.current.focused = false)}
    >
      <div className={styles.demoTabs} role="group" aria-label="Choose who is looking">
        {ORDER.map((tab) => (
          <button
            key={tab}
            type="button"
            className={styles.demoTab}
            aria-pressed={tab === audience}
            onClick={() => choose(tab)}
          >
            {TABS[tab]}
          </button>
        ))}
      </div>

      <div className={styles.demoCard} aria-live="polite">
        {/* Deliberately OUTSIDE the keyed region: the one cell that never animates,
            because it is the one thing no audience setting can hide. */}
        <span className={styles.demoTime}>2:00 PM</span>

        <div key={audience} className={styles.demoFields}>
          {audience === 'you' && (
            <>
              <span className={styles.demoTitle}>Legal call, custody</span>
              <span className={styles.demoDetail}>Conference Rm B</span>
              <PrivacyChip level="full" className={styles.demoChip} />
            </>
          )}
          {audience === 'client' && (
            <>
              <span className={styles.demoTitle}>Legal call</span>
              {/* role="img": aria-label is prohibited on a generic span, and this IS a
                  picture of a sealed field. */}
              <span className={styles.demoSealed} role="img" aria-label="Location hidden" />
              <PrivacyChip level="limited" className={styles.demoChip} />
            </>
          )}
          {audience === 'everyone' && (
            <>
              <span className={styles.demoTitle} data-muted="true">
                Busy
              </span>
              <PrivacyChip level="busy" className={styles.demoChip} />
            </>
          )}
        </div>
      </div>

      <p className={styles.demoCaption}>
        The time never hides. That part the server keeps, and we say so below.
      </p>
    </div>
  )
}
