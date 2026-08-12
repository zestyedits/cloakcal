'use client'

import { Suspense, useMemo, useState } from 'react'
import Link from 'next/link'
import type { RedactedOccurrence, RedactedPage } from '@/server/audience'
import type { AudienceOption } from '@/lib/audiences'
import { CloakProvider } from './cloak-provider'
import { CloakedText } from './cloaked-text'
import { ViewAsBar } from './view-as-bar'
import { WeekGrid } from './week-grid'
import { NewEvent } from './new-event'
import { DeleteEvent } from './delete-event'
import { EditableEvent } from './editable-event'
import { CloakLockup } from './cloak-logo'
import styles from './calendar-screen.module.css'

/**
 * The M1/M2 shell: agenda view, navigation frame, and View As.
 *
 * Everything rendered here has already been through the policy engine server-side. A
 * `busy` occurrence arrives with no fields and no calendar id at all — there is nothing
 * for this component to withhold, which is the point.
 */

/**
 * Agenda and Week read the SAME page of occurrences — one server fetch, already redacted —
 * so switching between them is a pure presentation choice and can stay on the client. Day
 * and Month need a different range, so they will be server navigations like the ‹ › steps
 * are, not additions to this list.
 */
const NAV = [
  { id: 'day', label: 'Day', ready: false },
  { id: 'week', label: 'Week', ready: true },
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

export interface WeekLink {
  readonly pathname: '/'
  readonly query: Record<string, string>
}

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
  heading,
  previousHref,
  nextHref,
  timezone,
  email,
  composeDate,
}: {
  page: RedactedPage
  audiences: readonly AudienceOption[]
  heading: string
  /* URL objects rather than strings: `typedRoutes` will not accept a computed href string,
     and a UrlObject is the escape hatch Next provides for exactly this — a fixed pathname
     with a query built at request time. */
  previousHref: WeekLink
  nextHref: WeekLink
  timezone: string
  email?: string | undefined
  /** YYYY-MM-DD the compose sheet opens on. Absent means composing is unavailable. */
  composeDate?: string | undefined
}) {
  const [view, setView] = useState<string>('agenda')
  const days = useMemo(() => groupByDay(page.occurrences), [page.occurrences])

  const colorFor = useMemo(() => {
    const map = new Map(page.calendars.map((c) => [c.id, c.colorToken]))
    return (calendarId: string | undefined) =>
      calendarId === undefined ? 'slate' : (map.get(calendarId) ?? 'indigo')
  }, [page.calendars])

  return (
    <CloakProvider page={page} email={email}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <CloakLockup size="sm" />

          {/* Real links, not buttons: a week is a location, so it should be shareable,
              bookmarkable and reachable with the back button. Server navigation also keeps
              redaction on the server — client-side week switching would mean shipping
              occurrences the audience is not entitled to. */}
          <nav className={styles.weekNav} aria-label="Change week">
            <Link className={styles.weekStep} href={previousHref} aria-label="Previous week">
              ‹
            </Link>
            <p className={styles.range} aria-live="polite">
              {heading}
            </p>
            <Link className={styles.weekStep} href={nextHref} aria-label="Next week">
              ›
            </Link>
          </nav>
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

          {/* Only when there is a real account behind it. The dev fixture has no session, so
              linking to a page that immediately redirects to sign-in would be a dead end. */}
          {email !== undefined && email !== '' && (
            <Link className={styles.account} href="/account">
              {email}
            </Link>
          )}
        </aside>

        <main id="main" className={styles.main}>
          {/* Two different facts, and conflating them was wrong. "Everything is hidden from
              this audience" is a privacy statement; an owner looking at a quiet week is not
              being told anything about privacy, and a fresh account read the old copy as a
              failure to load. withheldCount distinguishes them exactly. */}
          {days.length === 0 && (
            <p className={styles.empty}>
              {page.withheldCount > 0
                ? `Nothing here for this audience. ${page.withheldCount} ${
                    page.withheldCount === 1 ? 'event is' : 'events are'
                  } hidden from them entirely.`
                : page.audience === 'owner'
                  ? 'Nothing scheduled this week.'
                  : 'Nothing in this week for this audience.'}
            </p>
          )}

          {view === 'week' && days.length > 0 && (
            <WeekGrid
              occurrences={page.occurrences}
              from={page.from}
              timezone={timezone}
              colorFor={colorFor}
            />
          )}

          {/* Rendered conditionally rather than hidden: two copies of every title in the
              DOM would mean any assertion about a title matching twice, and a `hidden`
              subtree is still text a naive leak scan would find. */}
          {view === 'agenda' && (
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
                        {/* Owner-only, same guard as Delete below. For every other audience
                            the body renders exactly as it always did — a non-owner has
                            nothing to open, and nothing to be told about. */}
                        {page.audience === 'owner' && occurrence.version !== undefined ? (
                          <EditableEvent
                            eventId={occurrence.eventId}
                            version={occurrence.version}
                            recurring={occurrence.recurring ?? false}
                            series={occurrence.series ?? null}
                            occurrenceLocal={occurrence.occurrenceLocal}
                            timezone={timezone}
                            start={occurrence.start}
                            end={occurrence.end}
                            label={`the event at ${timeOf(occurrence.start)}`}
                          >
                            <CloakedText
                              className={styles.eventTitle}
                              subjectType="event"
                              subjectId={occurrence.eventId}
                              fieldName="title"
                              placeholder="Private event"
                            />
                          </EditableEvent>
                        ) : occurrence.time === 'busy' ? (
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
                      {/* Owner only, and only when the server actually sent a version to
                          guard the write with. Both conditions are already true together —
                          audience.ts only attaches `version` for the owner — but relying on
                          that coupling silently would make this the thing that breaks the
                          day the engine changes. */}
                      {page.audience === 'owner' && occurrence.version !== undefined && (
                        <DeleteEvent
                          eventId={occurrence.eventId}
                          version={occurrence.version}
                          recurring={occurrence.recurring ?? false}
                          // The occurrence's ORIGINAL local wall time, straight from the
                          // server. Never re-derived from `start`, which is a resolved
                          // instant — deriving it back would put a second wall-clock
                          // resolution in the codebase, and ADR 0001 allows exactly one.
                          occurrenceLocal={occurrence.occurrenceLocal}
                          label={`the event at ${timeOf(occurrence.start)}`}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
          )}
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

        {/* Composing is owner-only. Creating an event while viewing as someone else would
            be a confusing thing to offer and an easy thing to get wrong. */}
        {composeDate !== undefined && page.audience === 'owner' && (
          <NewEvent timezone={timezone} defaultDate={composeDate} />
        )}
      </div>
    </CloakProvider>
  )
}
