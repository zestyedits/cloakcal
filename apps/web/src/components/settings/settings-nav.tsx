'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { SECTIONS } from '@/lib/settings-sections'
import styles from './settings.module.css'

/**
 * THE rail, and the one thing on these pages that is meant to be looked at.
 *
 * It carries three jobs at once: it says where you are, it moves between pages, and inside
 * /settings it follows you down the page as you scroll. The marker is ONE element that
 * travels rather than five that blink on and off, which is the whole point — moving between
 * sections should read as a single object repositioning, not a highlight teleporting.
 *
 * WHY THE MARKER IS DECORATIVE AND `aria-current` IS NOT. The travelling element is a
 * `<span aria-hidden>`; the real state stays on the anchor, where a screen reader and
 * `e2e/settings.spec.ts` both already look for it. An accessible state that depended on an
 * animated element would be a state that is wrong for the length of a transition, and
 * absent entirely under reduced motion.
 *
 * WHY TRANSFORM AND NOT `top`/`height`. Animating geometry re-runs layout on every frame of
 * a sticky element sitting over a scroller. The marker is sized once and moved with a
 * transform, so the travel costs compositing and nothing else.
 */
export function SettingsNav({
  current,
  scope = 'hash',
}: {
  current: string | null
  /** `hash` on /settings, where the sections are on the page; `settings` from a sub-page. */
  scope?: 'hash' | 'settings'
}) {
  const listRef = useRef<HTMLElement | null>(null)
  const [marker, setMarker] = useState<{ x: number; y: number; w: number; h: number } | null>(
    null,
  )

  /**
   * Measure the active item and place the marker over it.
   *
   * useLayoutEffect so the position is set before the browser paints: measuring in a passive
   * effect would show the marker at its old spot for a frame, which on first load means
   * showing it in the wrong place entirely. It renders hidden until measured (`marker` is
   * null), so the failure mode is "absent for a frame", never "wrong for a frame".
   *
   * Re-measures on resize because the rail changes axis at 860px, and on font load because
   * the display face arrives late and moves every item under it.
   */
  useLayoutEffect(() => {
    const place = () => {
      const list = listRef.current
      if (list === null) return
      const active = list.querySelector<HTMLElement>('[aria-current]')
      if (active === null) {
        setMarker(null)
        return
      }
      setMarker({
        x: active.offsetLeft,
        y: active.offsetTop,
        w: active.offsetWidth,
        h: active.offsetHeight,
      })
    }

    place()
    const observer = new ResizeObserver(place)
    if (listRef.current !== null) observer.observe(listRef.current)
    window.addEventListener('resize', place)
    // The display face lands after first paint and shifts every label under it.
    void document.fonts?.ready.then(place)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [current])

  return (
    <nav className={styles.nav} aria-label="Settings sections" ref={listRef}>
      {/* Decorative. The state a machine reads lives on the anchors below. */}
      {marker !== null && (
        <span
          className={styles.navMarker}
          aria-hidden="true"
          style={{
            transform: `translate3d(${marker.x}px, ${marker.y}px, 0)`,
            width: `${marker.w}px`,
            height: `${marker.h}px`,
          }}
        />
      )}

      {SECTIONS.map((section, index) => (
        <a
          key={section.id}
          className={styles.navLink}
          href={scope === 'hash' ? `#${section.id}` : `/settings#${section.id}`}
          aria-current={section.id === current ? 'true' : undefined}
        >
          {/* The index that ties the rail to the plate: the same figure heads the band. */}
          <span className={styles.navIndex} aria-hidden="true">
            {String(index + 1).padStart(2, '0')}
          </span>
          {section.label}
        </a>
      ))}
    </nav>
  )
}

/**
 * Which section the reader is actually in.
 *
 * TWO SOURCES OF TRUTH, AND CLICKING HAS TO WIN. A hash says where someone was SENT; scroll
 * position says where they ARE. Deriving this from scroll alone looked right and was not:
 * every `pick()` produced an answer, so the hash was overwritten instantly and clicking a
 * rail item moved nothing. Deriving it from the hash alone is the opposite failure — the
 * marker stays where you last clicked while you read something else entirely.
 *
 * So a click PINS the choice, and the reader's next real scroll releases it. The pin ignores
 * scrolls for a moment after it is set, because following an anchor IS a scroll and would
 * otherwise cancel the thing that caused it.
 */
export function useVisibleSection(ids: readonly string[], pinned: string | null): string | null {
  const [visible, setVisible] = useState<string | null>(null)
  const pinnedUntil = useRef(0)

  useEffect(() => {
    if (pinned === null) return
    setVisible(pinned)
    pinnedUntil.current = Date.now() + 700
  }, [pinned])

  useEffect(() => {
    const targets = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null)
    if (targets.length === 0) return

    /**
     * The topmost section still below the header.
     *
     * The first version expressed this as an IntersectionObserver `rootMargin` band and
     * marked NOTHING, because a masthead, a reading plate and a demo banner push the first
     * section past where the band ended — the answer was always "none", silently, and the
     * rail sat blank. Reading rects at the moment something crosses is both simpler and
     * impossible to mis-tune.
     */
    const pick = () => {
      if (Date.now() < pinnedUntil.current) return
      const found = targets.find((el) => el.getBoundingClientRect().bottom > 96)
      // Nothing below the header means everything has scrolled past, which happens at the
      // FOOT of the page — so the answer is the last section, not the first. Falling back to
      // targets[0] sent the marker home at the one place the reader is definitely not.
      setVisible((found ?? targets[targets.length - 1])?.id ?? null)
    }

    const onScroll = () => {
      // A real scroll releases the pin. Opening a card and following its anchor does not.
      if (Date.now() >= pinnedUntil.current) pinnedUntil.current = 0
      pick()
    }

    pick()
    const observer = new IntersectionObserver(pick, { threshold: [0, 0.01, 1] })
    for (const target of targets) observer.observe(target)
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', pick)
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', pick)
    }
  }, [ids])

  return visible
}
