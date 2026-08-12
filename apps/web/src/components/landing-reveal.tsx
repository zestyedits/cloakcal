'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import styles from './landing.module.css'

/**
 * Scroll reveal, as progressive enhancement in the load-bearing order:
 *
 * 1. Server HTML is VISIBLE. A no-JS visitor, a crawler, and the pre-hydration frame all
 *    see the whole page.
 * 2. After first paint, an effect arms the hidden state only for sections still below
 *    the viewport, so nothing above the fold ever flashes.
 * 3. An IntersectionObserver lifts each section in as it approaches.
 *
 * Under prefers-reduced-motion the transition collapses to 1ms globally (tokens.css), so
 * an armed section becomes visible effectively instantly. No animation-timeline: Safari
 * is not there and no polyfill is allowed on this page.
 */
export function LandingReveal({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const node = ref.current
    if (node === null) return
    // Reduced motion means NO reveal choreography at all: content is simply present.
    // Arming would also leave sections invisible in any capture that never scrolls
    // (full-page screenshots reach below the fold without firing the observer).
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    // Already on screen: never arm, never animate. Arming here would hide visible content.
    if (node.getBoundingClientRect().top < window.innerHeight) return

    node.dataset['reveal'] = 'armed'
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          node.dataset['reveal'] = 'shown'
          observer.disconnect()
        }
      },
      { rootMargin: '0px 0px -10% 0px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={ref} className={styles.reveal}>
      {children}
    </div>
  )
}
