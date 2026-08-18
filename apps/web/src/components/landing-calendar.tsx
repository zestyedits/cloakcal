'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import styles from './landing-calendar.module.css'

/**
 * The hero: a real week, resealing itself as you change who is looking.
 *
 * WHY THIS REPLACED A CARD. The old demo made the pitch on one event with three tabs, and
 * the pitch is not "a field can be hidden" — every calendar can hide a field. It is that the
 * SAME WEEK reads differently to four different people at once, per person, per event. That
 * is only legible at week scale: one card can show a redaction, but it cannot show a client
 * seeing their own two meetings in full while everything around them collapses to Busy.
 *
 * FOUR THINGS THE ANIMATION HAS TO SAY, and each is a design constraint rather than decoration:
 *
 *  1. The GRID NEVER MOVES. Columns, hour lines and every block's position and size are
 *     identical in all four states — only the contents change. That is rule 1 drawn instead
 *     of stated: the server keeps times, durations and repeats readable, and no audience
 *     setting hides them. If a block slid or resized when the audience changed, the picture
 *     would be claiming something the product does not do.
 *  2. Hidden is ABSENT, not dimmed. A hidden event leaves clean grid, the same way the dates
 *     under the cloak in the mark are missing rather than greyed. A dimmed block still tells
 *     you something is there, which is the leak the whole product exists to close.
 *  3. It sweeps rather than cuts. Blocks reseal on a stagger keyed to their column, so the
 *     change reads as one motion crossing the week rather than seven unrelated flickers.
 *  4. It is honest about being a picture. Static invented strings, no crypto, no keys, no
 *     network. Nothing here is a real calendar and nothing here pretends to be.
 *
 * Auto-advance is polite by the same rules the old demo used and for the same reason
 * (WCAG 2.2.2): only while on screen, never once the visitor has chosen, not while hovered
 * or focused, never under reduced motion, and it stops for good after three passes. The
 * buttons are the manual control, so nothing is lost when it stops.
 */

type AudienceId = 'you' | 'client' | 'work' | 'public'

/** The product's four levels, and the only four this can render. */
type Level = 'full' | 'limited' | 'busy' | 'hidden'

interface Audience {
  readonly id: AudienceId
  readonly name: string
  readonly role: string
  /** Two letters for the marker. Not initials of a real person; these people are invented. */
  readonly mark: string
}

const AUDIENCES: readonly Audience[] = [
  { id: 'you', name: 'You', role: 'Your own view', mark: 'You' },
  { id: 'client', name: 'Priya', role: 'A client', mark: 'PR' },
  { id: 'work', name: 'Marcus', role: 'A colleague', mark: 'MA' },
  { id: 'public', name: 'Everyone else', role: 'No relationship', mark: '··' },
]

interface DemoEvent {
  readonly id: string
  /** 0 = Monday. */
  readonly day: number
  /** Decimal hours in a 9-to-17 grid. */
  readonly start: number
  readonly end: number
  readonly title: string
  /** The second line at `full`. Dropped at `limited`, which is what limited means. */
  readonly place: string
  readonly color: 'indigo' | 'teal' | 'violet' | 'rose'
  readonly levels: Readonly<Record<AudienceId, Level>>
}

/**
 * One consultant's week, invented.
 *
 * The rules are the point, so they are not uniform: Priya sees HER OWN two meetings in full
 * and almost nothing else, Marcus sees the work and none of the private, and everyone else
 * gets a wall of Busy with the personal days simply not there. A demo where each audience
 * just sees "less" would be a brightness slider, not a per-person rule engine.
 */
const EVENTS: readonly DemoEvent[] = [
  {
    id: 'standup',
    day: 0,
    start: 9,
    end: 9.5,
    title: 'Team standup',
    place: 'Video call',
    color: 'teal',
    levels: { you: 'full', client: 'busy', work: 'full', public: 'busy' },
  },
  {
    id: 'lunch',
    day: 0,
    start: 12.5,
    end: 13.5,
    title: 'Lunch with Sam',
    place: 'Cafe Mira',
    color: 'rose',
    levels: { you: 'full', client: 'hidden', work: 'busy', public: 'hidden' },
  },
  {
    id: 'discovery',
    day: 1,
    start: 10,
    end: 11.5,
    title: 'Discovery call, Novaline',
    place: 'Video call',
    color: 'indigo',
    // Priya's own meeting. She sees it in full; Marcus gets the title without the client.
    levels: { you: 'full', client: 'full', work: 'limited', public: 'busy' },
  },
  {
    id: 'therapy',
    day: 2,
    start: 11,
    end: 12,
    title: 'Therapy',
    place: 'Dr. Okafor',
    color: 'rose',
    // Hidden from all three. The row that makes "absent, not dimmed" mean something.
    levels: { you: 'full', client: 'hidden', work: 'hidden', public: 'hidden' },
  },
  {
    id: 'review',
    day: 2,
    start: 15,
    end: 16,
    title: 'Design review',
    place: 'Studio',
    color: 'teal',
    levels: { you: 'full', client: 'busy', work: 'full', public: 'busy' },
  },
  {
    id: 'contract',
    day: 3,
    start: 9.5,
    end: 10.5,
    title: 'Novaline, contract',
    place: 'Video call',
    color: 'indigo',
    levels: { you: 'full', client: 'full', work: 'limited', public: 'busy' },
  },
  {
    id: 'pickup',
    day: 4,
    start: 15,
    end: 16,
    title: 'School pickup',
    place: 'Fairview',
    color: 'rose',
    levels: { you: 'full', client: 'hidden', work: 'busy', public: 'hidden' },
  },
]

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] as const
const START_HOUR = 9
const END_HOUR = 17
const HOURS = Array.from({ length: END_HOUR - START_HOUR + 1 }, (_, i) => START_HOUR + i)

const HOLD_MS = 3800
const MAX_PASSES = 3

/** 12-hour clock without a library: this grid is 9 to 17 and nothing else. */
const hourLabel = (hour: number): string => (hour === 12 ? 'noon' : hour > 12 ? `${hour - 12}` : `${hour}`)

const LEVEL_WORD: Record<Level, string> = {
  full: 'in full',
  limited: 'with limited details',
  busy: 'as busy only',
  hidden: 'hidden entirely',
}

export function LandingCalendar() {
  const [audienceId, setAudienceId] = useState<AudienceId>('you')
  const [chosen, setChosen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const rest = useRef({ hovered: false, focused: false, visible: false, ticks: 0 })

  useEffect(() => {
    if (chosen) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const root = rootRef.current
    if (root === null) return

    const observer = new IntersectionObserver(([entry]) => {
      rest.current.visible = entry?.isIntersecting ?? false
    })
    observer.observe(root)

    const interval = window.setInterval(() => {
      const state = rest.current
      if (!state.visible || state.hovered || state.focused) return
      if (state.ticks >= MAX_PASSES * AUDIENCES.length) {
        window.clearInterval(interval)
        return
      }
      state.ticks += 1
      setAudienceId((current) => {
        const index = AUDIENCES.findIndex((a) => a.id === current)
        return AUDIENCES[(index + 1) % AUDIENCES.length]!.id
      })
    }, HOLD_MS)

    return () => {
      observer.disconnect()
      window.clearInterval(interval)
    }
  }, [chosen])

  const audience = AUDIENCES.find((a) => a.id === audienceId) ?? AUDIENCES[0]!

  /**
   * One sentence for assistive tech, instead of seven blocks announcing themselves.
   *
   * A live region on the grid would fire up to seven times per change and read as noise. The
   * summary is the thing a sighted visitor actually takes from the animation, so it is what
   * gets announced.
   */
  const summary = useMemo(() => {
    const counts: Record<Level, number> = { full: 0, limited: 0, busy: 0, hidden: 0 }
    for (const event of EVENTS) counts[event.levels[audienceId]] += 1
    return (['full', 'limited', 'busy', 'hidden'] as const)
      .filter((level) => counts[level] > 0)
      .map((level) => `${counts[level]} ${LEVEL_WORD[level]}`)
      .join(', ')
  }, [audienceId])

  return (
    <div
      ref={rootRef}
      className={styles.root}
      onMouseEnter={() => (rest.current.hovered = true)}
      onMouseLeave={() => (rest.current.hovered = false)}
      onFocus={() => (rest.current.focused = true)}
      onBlur={() => (rest.current.focused = false)}
    >
      <div className={styles.chrome}>
        {/* THIS IS THE PAGE'S CALL TO ACTION while sign-ups are closed, which is why it
            reads as an instruction rather than as a filter label. "Who is looking" named
            the control; "Show the week as" asks for something, and the thing it asks for
            is the product's whole argument performed on the visitor's own screen. */}
        <span className={styles.chromeLabel}>Show the week as</span>
        <div className={styles.people} role="group" aria-label="Show the week as">
          {AUDIENCES.map((person) => (
            <button
              key={person.id}
              type="button"
              className={styles.person}
              aria-pressed={person.id === audienceId}
              onClick={() => {
                setChosen(true)
                setAudienceId(person.id)
              }}
            >
              <span className={styles.personMark} data-self={person.id === 'you' || undefined} aria-hidden="true">
                {person.mark}
              </span>
              <span className={styles.personText}>
                <span className={styles.personName}>{person.name}</span>
                <span className={styles.personRole}>{person.role}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* `key` on the grid replays the sweep and every block's stagger on each change. */}
      <div key={audienceId} className={styles.grid} aria-hidden="true">
        <div className={styles.sweep} />

        <div className={styles.gutter}>
          {HOURS.slice(0, -1).map((hour) => (
            <span key={hour} className={styles.hour} style={{ '--h': hour - START_HOUR } as React.CSSProperties}>
              {hourLabel(hour)}
            </span>
          ))}
        </div>

        {/* The days scroll; the hour gutter beside them does not. Same answer WeekGrid
            reaches in the product: at 390px five columns is 55px each, and a week squeezed
            until every title reads "Tea..." has stopped showing anything. */}
        <div className={styles.daysScroller}>
        <div className={styles.days}>
          {DAYS.map((day, index) => (
            <div key={day} className={styles.day}>
              <span className={styles.dayName}>{day}</span>
              <div className={styles.column}>
                {HOURS.slice(0, -1).map((hour) => (
                  <span key={hour} className={styles.rule} />
                ))}

                {EVENTS.filter((event) => event.day === index).map((event) => {
                  const level = event.levels[audienceId]
                  if (level === 'hidden') return null
                  return (
                    <span
                      key={event.id}
                      className={styles.block}
                      data-level={level}
                      data-color={event.color}
                      // A half-hour block has about 1.25rem of usable height, and a second
                      // line inside it is not clipped so much as sliced in half. Marked in
                      // the markup rather than sniffed from the style attribute, which
                      // would depend on how React happens to serialise a custom property.
                      data-short={event.end - event.start <= 0.5 || undefined}
                      style={
                        {
                          '--from': event.start - START_HOUR,
                          '--span': event.end - event.start,
                          '--col': index,
                        } as React.CSSProperties
                      }
                    >
                      <span className={styles.blockTitle}>
                        {level === 'busy' ? 'Busy' : event.title}
                      </span>
                      {level === 'full' && (
                        <span className={styles.blockPlace}>{event.place}</span>
                      )}
                    </span>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
        </div>
      </div>

      {/*
        The whole picture, in words, for anyone not looking at it. The grid above is
        aria-hidden precisely so this can be the single clear description instead of
        seven blocks and forty grid lines being walked one at a time.
      */}
      {/*
        One sentence, doing both jobs. The grid above is aria-hidden precisely so this can be
        a single clear description instead of seven blocks and forty grid lines being walked
        one at a time — so it must be complete enough to stand alone, which also makes it the
        right caption for someone who IS looking at the grid.
      */}
      <p className={styles.summary} aria-live="polite">
        Of {EVENTS.length} events this week, <strong>{audience.name}</strong> sees {summary}.
      </p>

      <p className={styles.caption}>
        The times never move. Durations, repeats and free-busy stay readable, because
        reminders and booking need them. Everything else is yours to give away or keep.
      </p>
    </div>
  )
}
