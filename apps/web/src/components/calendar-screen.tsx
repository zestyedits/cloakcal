'use client'

import { Suspense, useMemo, useState } from 'react'
import type { RedactedOccurrence, RedactedPage } from '@/server/audience'
import { CloakProvider } from './cloak-provider'
import { CloakedText } from './cloaked-text'
import { ViewAsBar } from './view-as-bar'
import styles from './calendar-screen.module.css'

/**
 * The M1/M2 shell: agenda view, navigation frame, and View As.
 *
 * Everything rendered here has already been through the policy engine server-side. A
 * `busy` occurrence arrives with no fields and no calendar id at all — there is nothing
 * for this component to withhold, which is the point.
 */

const NAV = [
  { id: 'day', label: 'Day', ready: false },
  { id: 'week', label: 'Week', ready: false },
  { id: 'agenda', label: 'Agenda', ready: true },
  { id: 'month', label: 'Month', ready: false },
] as const

const DAY_LABEL = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
})

const timeOf = (iso: string) => (iso.includes('T') ? iso.slice(11, 16) : 'All day')

function groupByDay(occurrences: readonly RedactedOccurrence[]) {
  const days = new Map<string, RedactedOccurrence[]>()
  for (const occurrence of occurrences) {
    const day = occurrence.occurrenceLocal.slice(0, 10)
    const bucket = days.get(day)
    if (bucket === undefined) days.set(day, [occurrence])
    else bucket.push(occurrence)
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b))
}

export function CalendarScreen({
  page,
  audiences,
}: {
  page: RedactedPage
  audiences: ReadonlyArray<{ id: string; label: string }>
}) {
  const [view, setView] = useState<string>('agenda')
  const days = useMemo(() => groupByDay(page.occurrences), [page.occurrences])

  const colorFor = useMemo(() => {
    const map = new Map(page.calendars.map((c) => [c.id, c.colorToken]))
    return (calendarId: string | undefined) =>
      calendarId === undefined ? 'slate' : (map.get(calendarId) ?? 'indigo')
  }, [page.calendars])

  return (
    <CloakProvider page={page}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div className={styles.brand}>
            <span className={styles.mark} aria-hidden="true" />
            <span className={styles.wordmark}>
              Cloak<span className={styles.wordmarkAccent}>Cal</span>
            </span>
          </div>
          <p className={styles.range}>May 18 – 24, 2026</p>
        </header>

        <aside className={styles.sidebar} aria-label="Calendars">
          <Suspense fallback={null}>
            <ViewAsBar
              audiences={audiences}
              current={page.audience}
              withheldCount={page.withheldCount}
            />
          </Suspense>

          {page.calendars.length > 0 && (
            <>
              <h2 className={styles.sidebarHeading}>My calendars</h2>
              <ul className={styles.calendarList}>
                {page.calendars.map((calendar) => (
                  <li key={calendar.id} className={styles.calendarItem}>
                    <span
                      className={styles.swatch}
                      data-color={calendar.colorToken}
                      aria-hidden="true"
                    />
                    <CloakedText
                      subjectType="calendar"
                      subjectId={calendar.id}
                      fieldName="display_name"
                      placeholder="Calendar"
                    />
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>

        <main id="main" className={styles.main}>
          {days.length === 0 && (
            <p className={styles.empty}>
              Nothing here for this audience. Every event in this week is hidden from them.
            </p>
          )}

          <ol className={styles.agenda}>
            {days.map(([day, occurrences]) => (
              <li key={day} className={styles.day}>
                <h2 className={styles.dayHeading}>
                  {DAY_LABEL.format(new Date(`${day}T00:00:00Z`))}
                </h2>
                <ul className={styles.events}>
                  {occurrences.map((occurrence) => (
                    <li
                      key={`${occurrence.eventId}:${occurrence.occurrenceLocal}`}
                      className={styles.event}
                      data-color={colorFor(occurrence.calendarId)}
                      data-time={occurrence.time}
                    >
                      <span className={styles.time}>{timeOf(occurrence.start)}</span>
                      <span className={styles.eventBody}>
                        {occurrence.time === 'busy' ? (
                          // Nothing to reveal: the server sent no fields for this one.
                          <span className={styles.eventTitle}>Busy</span>
                        ) : (
                          <CloakedText
                            className={styles.eventTitle}
                            subjectType="event"
                            subjectId={occurrence.eventId}
                            fieldName="title"
                            placeholder="Private event"
                          />
                        )}
                        {occurrence.dst !== 'none' && (
                          <span className={styles.dstNote}>
                            {occurrence.dst === 'nonexistent-shifted'
                              ? 'Moved by a daylight saving change'
                              : 'Falls in a repeated hour'}
                          </span>
                        )}
                      </span>
                      <span className={styles.busy} data-busy={occurrence.busy ?? 'busy'}>
                        {occurrence.busy === 'free' ? 'Free' : 'Busy'}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </main>

        <nav className={styles.nav} aria-label="Calendar views">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className={styles.navItem}
              aria-current={view === item.id ? 'page' : undefined}
              disabled={!item.ready}
              title={item.ready ? undefined : 'Coming in a later milestone'}
              onClick={() => setView(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </div>
    </CloakProvider>
  )
}
