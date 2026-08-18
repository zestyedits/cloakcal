'use client'

import { useMemo } from 'react'
import { PRIVACY_LEVELS } from '@cloakcal/ui'
import { primaryHoliday, type HolidayMap } from '@cloakcal/domain'
import type { AvailabilityWeek } from '@/server/availability'
import type { DisclosureLevel } from '@cloakcal/policy'
import type { RedactedOccurrence } from '@/server/audience'
import { CloakedText } from './cloaked-text'
import { EditableEvent } from './editable-event'
import { Icon, type IconName } from './ui/icons'
import { wallTimeLabel } from '@/lib/wall-time'
import styles from './week-grid.module.css'

/**
 * Week view.
 *
 * MOBILE-FIRST, AND THAT CHANGED THE DESIGN. Seven columns of a 24-hour grid on a phone is
 * a smear. So the grid scrolls horizontally with the hour gutter pinned, and each column is
 * wide enough to read rather than squeezed to fit — you see three days at a time and swipe,
 * instead of seeing seven days of nothing. Desktop gets all seven at once from 900px, which
 * is the same breakpoint the sidebar uses.
 *
 * BOUNDED VERTICALLY, ON PURPOSE. Rendering midnight to midnight means most of the screen is
 * empty and the day's actual shape is somewhere off-screen. The grid instead spans only the
 * hours the week uses, padded by one either side, and falls back to a working day when the
 * week is empty. The house rule is no endless scrolling on mobile, and a fixed 24-hour
 * canvas is endless scrolling with extra steps.
 *
 * WHAT IT DOES NOT DO. It does not decide what to show. Every occurrence here has already
 * been through the policy engine on the server; a `busy` block arrives with no fields and no
 * calendar id, so there is nothing for this component to withhold or leak.
 */

const DAY_MS = 86_400_000
const DEFAULT_START_HOUR = 8
const DEFAULT_END_HOUR = 20

/** Minutes past local midnight, read straight off the ISO string. */
const minutesOf = (iso: string): number => {
  if (!iso.includes('T')) return 0
  return Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16))
}

const dateOf = (iso: string): string => iso.slice(0, 10)

const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' })

interface Placed {
  readonly occurrence: RedactedOccurrence
  readonly top: number
  readonly height: number
  /** Column index and count, for events that overlap in time. */
  readonly lane: number
  readonly lanes: number
}

/**
 * Lay out one day's events so overlaps sit side by side.
 *
 * Greedy interval colouring: sweep in start order and reuse the first lane whose previous
 * event has ended. It is not the tightest possible packing, but it is stable — the same
 * events always land in the same lanes, so a re-render never shuffles the layout under the
 * user's cursor. A cleverer algorithm that moved events around on every render would be a
 * worse calendar.
 */
function layout(day: readonly RedactedOccurrence[], startMinute: number, span: number): Placed[] {
  const sorted = [...day].sort((a, b) => minutesOf(a.start) - minutesOf(b.start))
  const laneEnds: number[] = []
  const assigned: Array<{ occurrence: RedactedOccurrence; from: number; to: number; lane: number }> = []

  for (const occurrence of sorted) {
    const from = minutesOf(occurrence.start)
    // An end that is not after the start means an overnight or zero-length event; give it a
    // legible minimum rather than a zero-height sliver nobody can tap.
    const rawTo = minutesOf(occurrence.end)
    const to = rawTo > from ? rawTo : from + 30

    let lane = laneEnds.findIndex((end) => end <= from)
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(to)
    } else {
      laneEnds[lane] = to
    }

    assigned.push({ occurrence, from, to, lane })
  }

  const lanes = Math.max(1, laneEnds.length)

  return assigned.map(({ occurrence, from, to, lane }) => ({
    occurrence,
    top: ((from - startMinute) / span) * 100,
    height: Math.max(((to - from) / span) * 100, 2.5),
    lane,
    lanes,
  }))
}

/**
 * The bands of a day that fall OUTSIDE its availability, clipped to the visible span.
 *
 * Returns nothing when the day has no windows, and that is the important case: no rows means
 * NOT SET rather than "unavailable" (0027), so an account that has never opened the settings
 * page gets a clean grid instead of one shaded end to end.
 *
 * The date string is `YYYY-MM-DD` in the display zone and the weekday is derived from it with
 * Date.UTC, never `new Date(day)` — parsing a bare date as local time is the drift this whole
 * codebase is careful about, and here it would shade the wrong column.
 */
function outsideHours(
  day: string,
  availability: AvailabilityWeek,
  startMinute: number,
  endMinute: number,
): { from: number; to: number }[] {
  const weekday = new Date(
    Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))),
  ).getUTCDay()

  const windows = availability[weekday]
  if (windows === undefined || windows.length === 0) return []

  // The gaps between (and around) the windows, then clipped to what is on screen.
  const bands: { from: number; to: number }[] = []
  let cursor = 0
  for (const window of [...windows].sort((a, b) => a.startMinute - b.startMinute)) {
    if (window.startMinute > cursor) bands.push({ from: cursor, to: window.startMinute })
    cursor = Math.max(cursor, window.endMinute)
  }
  if (cursor < 1440) bands.push({ from: cursor, to: 1440 })

  return bands
    .map((band) => ({
      from: Math.max(band.from, startMinute),
      to: Math.min(band.to, endMinute),
    }))
    .filter((band) => band.to > band.from)
}

export function WeekGrid({
  occurrences,
  from,
  timezone,
  colorFor,
  baselineLevel,
  dayCount = 7,
  audience,
  onOpenVisibility,
  onComposeSlot,
  holidays = {},
  availability = {},
}: {
  occurrences: readonly RedactedOccurrence[]
  /** ISO instant for the first day of the week. */
  from: string
  timezone: string
  colorFor: (calendarId: string | undefined) => string
  /** 7 for the week, 1 for the day view — same grid, same lane packing, fewer columns. */
  dayCount?: number
  /**
   * Belt-and-braces beside the version check, same as the agenda row: `version` is only
   * attached for the owner (audience.ts), but the write path must not silently rely on
   * that coupling.
   */
  audience?: string | undefined
  /**
   * The workspace baseline a block's privacy note is measured against (see audience.ts).
   *
   * A prop rather than a field on each occurrence because it is one value for the whole
   * page: workspace rules do not vary by event, so carrying a copy on every block would put
   * the same string in the Flight payload once per event and invite the two from drifting.
   */
  baselineLevel?: DisclosureLevel | undefined
  /** The screen-level Event Visibility sheet's opener; absent = no visibility door. */
  onOpenVisibility?: ((eventId: string) => void) | undefined
  /**
   * Compose-at-this-slot: clicking empty grid opens the compose sheet on that day and
   * hour. Absent (a non-owner, or nowhere to compose) the empty grid stays plain
   * decoration, exactly as before — same present-or-absent grammar as the doors above.
   */
  onComposeSlot?: ((date: string, time: string) => void) | undefined
  /**
   * Public holidays by date. Not occurrences: they render in the column HEAD, never in the
   * grid body, because nothing here is an appointment with a time. Putting one in the
   * all-day band would make it look like an event that could be opened, moved or hidden.
   */
  holidays?: HolidayMap
  /**
   * Weekly availability, as wall-clock minutes past local midnight (0027).
   *
   * Shades the hours OUTSIDE it. Decoration and nothing else: `aria-hidden`, behind every
   * block, and it never changes the grid's hour span — see the note at the shading below for
   * why widening the span to cover availability would be the wrong call.
   */
  availability?: AvailabilityWeek
}) {
  const days = useMemo(() => {
    // Built from the range rather than from the data, so an empty Wednesday still gets a
    // column. A week view that silently omits quiet days is not a week view.
    const first = new Date(from)
    const labels = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })

    return Array.from({ length: dayCount }, (_, index) =>
      labels.format(new Date(first.getTime() + index * DAY_MS)),
    )
  }, [from, timezone, dayCount])

  const timed = useMemo(() => occurrences.filter((o) => o.start.includes('T')), [occurrences])
  const allDay = useMemo(() => occurrences.filter((o) => !o.start.includes('T')), [occurrences])

  const { startMinute, endMinute } = useMemo(() => {
    if (timed.length === 0) {
      return { startMinute: DEFAULT_START_HOUR * 60, endMinute: DEFAULT_END_HOUR * 60 }
    }

    let earliest = Number.POSITIVE_INFINITY
    let latest = Number.NEGATIVE_INFINITY
    for (const occurrence of timed) {
      earliest = Math.min(earliest, minutesOf(occurrence.start))
      latest = Math.max(latest, Math.max(minutesOf(occurrence.end), minutesOf(occurrence.start) + 30))
    }

    // Snap out to whole hours and pad by one, so the first and last event of the week are
    // never flush against the edge of the grid.
    return {
      startMinute: Math.max(0, Math.floor(earliest / 60) * 60 - 60),
      endMinute: Math.min(24 * 60, Math.ceil(latest / 60) * 60 + 60),
    }
  }, [timed])

  const span = Math.max(60, endMinute - startMinute)
  const hours = Array.from({ length: Math.ceil(span / 60) + 1 }, (_, i) => startMinute / 60 + i)

  const byDay = useMemo(() => {
    const map = new Map<string, RedactedOccurrence[]>()
    for (const occurrence of timed) {
      const key = dateOf(occurrence.start)
      const bucket = map.get(key)
      if (bucket === undefined) map.set(key, [occurrence])
      else bucket.push(occurrence)
    }
    return map
  }, [timed])

  const allDayByDay = useMemo(() => {
    const map = new Map<string, RedactedOccurrence[]>()
    for (const occurrence of allDay) {
      const key = dateOf(occurrence.start)
      const bucket = map.get(key)
      if (bucket === undefined) map.set(key, [occurrence])
      else bucket.push(occurrence)
    }
    return map
  }, [allDay])

  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())

  return (
    <div className={styles.scroller}>
      <div
        className={styles.grid}
        style={
          { '--hour-count': hours.length - 1, '--day-count': days.length } as React.CSSProperties
        }
      >
        {/* Corner: empty, but it has to exist so the gutter and headers stay aligned. */}
        <div className={styles.corner} aria-hidden="true" />

        {days.map((day) => (
          <div key={`head-${day}`} className={styles.dayHead} data-today={day === today}>
            <span className={styles.dayName}>{WEEKDAY.format(new Date(`${day}T00:00:00Z`))}</span>
            <span className={styles.dayNumber}>{Number(day.slice(8, 10))}</span>
            {/* `title` carries the full name a narrow column has to truncate. Not the only
                route to it: the agenda heading and the month cell both render it in full. */}
            {(() => {
              const holiday = primaryHoliday(holidays[day])
              return holiday === undefined ? null : (
                <span
                  className={styles.holiday}
                  data-kind={holiday.kind}
                  title={holiday.name}
                >
                  {holiday.name}
                </span>
              )
            })()}
          </div>
        ))}

        {/* All-day row. Present only when something is in it — an always-visible empty band
            costs vertical space on a phone for no information. */}
        {allDay.length > 0 && (
          <>
            <div className={styles.allDayLabel}>All day</div>
            {days.map((day) => (
              <div key={`allday-${day}`} className={styles.allDayCell}>
                {(allDayByDay.get(day) ?? []).map((occurrence) => (
                  <span
                    key={occurrence.eventId}
                    className={styles.allDayChip}
                    data-color={colorFor(occurrence.calendarId)}
                  >
                    {/* Same door as the timed blocks; the agenda already opens all-day
                        rows, so this is parity, not new behaviour. */}
                    {audience === 'owner' && occurrence.version !== undefined && (
                      <EditableEvent
                        variant="block"
                        eventId={occurrence.eventId}
                        version={occurrence.version}
                        recurring={occurrence.recurring ?? false}
                        series={occurrence.series ?? null}
                        occurrenceLocal={occurrence.occurrenceLocal}
                        timezone={timezone}
                        start={occurrence.start}
                        end={occurrence.end}
                        label={`the all-day event on ${day}`}
                      />
                    )}
                    {occurrence.time === 'busy' ? (
                      'Busy'
                    ) : (
                      <CloakedText
                        subjectType="event"
                        subjectId={occurrence.eventId}
                        fieldName="title"
                        placeholder="Private event"
                      />
                    )}
                  </span>
                ))}
              </div>
            ))}
          </>
        )}

        <div className={styles.gutter}>
          {hours.slice(0, -1).map((hour) => (
            <span key={hour} className={styles.hourLabel}>
              {formatHour(hour)}
            </span>
          ))}
        </div>

        {days.map((day) => {
          const placed = layout(byDay.get(day) ?? [], startMinute, span)

          return (
            <div key={`col-${day}`} className={styles.column} data-today={day === today}>
              {/*
                OUTSIDE your working hours: a quiet wash behind everything.

                THE SPAN IS NOT WIDENED to cover availability, deliberately. The grid's hours
                come from the events in view (see startMinute/endMinute above), and stretching
                it to fit a 9-to-5 window would resize every week screenshot in the suite and
                make a quiet day taller for no information. This shades what is already on
                screen, so on a default 8-to-18 span you see the 8-9 and 17-18 edges and on a
                busy day you may see none — which is correct, not a bug.

                Decoration only: aria-hidden, no pointer events, and it must never be mistaken
                for an event, so it is a flat wash with no border and no colour.
              */}
              {outsideHours(day, availability, startMinute, endMinute).map((band, i) => (
                <div
                  key={`closed-${i}`}
                  className={styles.closed}
                  aria-hidden="true"
                  style={
                    {
                      '--top': (band.from - startMinute) / span,
                      '--height': (band.to - band.from) / span,
                    } as React.CSSProperties
                  }
                />
              ))}
              {/* Empty grid becomes a compose door when there is somewhere to compose: one
                  button per hour cell, named by day and hour so the accessible name carries
                  exactly what the click will prefill — and, like every constructed name in
                  the grids, no title can ever leak into it. Event blocks sit ABOVE these
                  (absolute, z-index 1 and 2), so a click on an event still opens the event.
                  The 91-control density has precedent: the month and mini-month grids are
                  42 links each. Without the handler these stay the decorative hour lines
                  they always were. */}
              {hours.slice(0, -1).map((hour) =>
                onComposeSlot === undefined ? (
                  <div key={hour} className={styles.hourLine} aria-hidden="true" />
                ) : (
                  <button
                    key={hour}
                    type="button"
                    className={styles.hourSlot}
                    aria-label={`New event on ${day} at ${formatHour(hour)}`}
                    onClick={() =>
                      onComposeSlot(day, `${String(((hour % 24) + 24) % 24).padStart(2, '0')}:00`)
                    }
                  />
                ),
              )}

              {placed.map(({ occurrence, top, height, lane, lanes }) => {
                // The agenda's guard, verbatim: version only exists for the owner, and the
                // audience check is the deliberate second lock on the same door.
                const editable =
                  audience === 'owner' && occurrence.version !== undefined
                // Empty for all-day: the grid positions those separately and a label would double up.
                const timeLabel = wallTimeLabel(occurrence.start, '')

                return (
                  <article
                    key={`${occurrence.eventId}:${occurrence.occurrenceLocal}`}
                    className={styles.event}
                    data-color={colorFor(occurrence.calendarId)}
                    data-time={occurrence.time}
                    data-busy={occurrence.busy ?? 'busy'}
                    style={{
                      top: `${top}%`,
                      height: `${height}%`,
                      left: `${(lane / lanes) * 100}%`,
                      width: `${100 / lanes}%`,
                    }}
                  >
                    {/* The block is the edit door, same semantics as tapping an agenda
                        row. A stretched button rather than a wrapping one, because the
                        block's children are laid out by the grid. No delete control ON
                        the block, on purpose: a third control does not fit a 28px block,
                        and delete is the one action that must never be a mis-tap — the
                        edit sheet this opens carries Delete now, behind its own
                        confirmation. */}
                    {editable && occurrence.version !== undefined && (
                      <EditableEvent
                        variant="block"
                        eventId={occurrence.eventId}
                        version={occurrence.version}
                        recurring={occurrence.recurring ?? false}
                        series={occurrence.series ?? null}
                        occurrenceLocal={occurrence.occurrenceLocal}
                        timezone={timezone}
                        start={occurrence.start}
                        end={occurrence.end}
                        label={`the event at ${timeLabel}`}
                      />
                    )}
                    <span className={styles.eventTime}>{timeLabel}</span>
                    <span className={styles.eventTitle}>
                      {occurrence.time === 'busy' ? (
                        'Busy'
                      ) : (
                        <CloakedText
                          subjectType="event"
                          subjectId={occurrence.eventId}
                          fieldName="title"
                          placeholder="Private event"
                        />
                      )}
                    </span>
                    {/* The board's second line, under the agenda's rule: the privacy
                        level only where this event DIFFERS from the workspace baseline,
                        the calendar name otherwise. See calendar-screen.tsx for why the
                        baseline comparison replaced "unless it is full" — the short version
                        is that the widest disclosure is a workspace setting, so printing it
                        on every block said one thing N times. Rendered in the block's own
                        ink — the blocks sit on calendar-coloured washes the chip ink pairs
                        were never computed against, and the icon + label carry the meaning
                        without colour. Short blocks clip it via overflow; the title always
                        wins.

                        For the owner it is also the visibility door, exactly like the
                        agenda's chip: a button ABOVE the stretched edit trigger
                        (z-index 2 over 1). Its aria-label is built from the time only. */}
                    {occurrence.privacyLevel !== undefined &&
                      (editable && onOpenVisibility !== undefined ? (
                        <button
                          type="button"
                          className={styles.privacyNoteButton}
                          aria-label={`Change who can see the event at ${timeLabel}`}
                          onClick={() => onOpenVisibility(occurrence.eventId)}
                        >
                          {occurrence.privacyLevel !== baselineLevel ? (
                            <>
                              <Icon
                                name={PRIVACY_LEVELS[occurrence.privacyLevel].icon as IconName}
                                size={11}
                              />
                              {PRIVACY_LEVELS[occurrence.privacyLevel].label}
                            </>
                          ) : occurrence.calendarId !== undefined ? (
                            <CloakedText
                              subjectType="calendar"
                              subjectId={occurrence.calendarId}
                              fieldName="display_name"
                              placeholder="Calendar"
                            />
                          ) : (
                            PRIVACY_LEVELS[baselineLevel ?? occurrence.privacyLevel]
                              .label
                          )}
                        </button>
                      ) : occurrence.privacyLevel !== baselineLevel ? (
                        <span className={styles.privacyNote}>
                          <Icon
                            name={PRIVACY_LEVELS[occurrence.privacyLevel].icon as IconName}
                            size={11}
                          />
                          {PRIVACY_LEVELS[occurrence.privacyLevel].label}
                        </span>
                      ) : occurrence.calendarId !== undefined ? (
                        <CloakedText
                          className={styles.privacyNote}
                          subjectType="calendar"
                          subjectId={occurrence.calendarId}
                          fieldName="display_name"
                          placeholder="Calendar"
                        />
                      ) : null)}
                    {occurrence.dst !== 'none' && (
                      <span className={styles.dstNote}>
                        {occurrence.dst === 'nonexistent-shifted' ? 'DST shifted' : 'Repeated hour'}
                      </span>
                    )}
                  </article>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 12-hour labels without the minutes, which are noise in an hour gutter. */
function formatHour(hour: number): string {
  const h = ((hour % 24) + 24) % 24
  if (h === 0) return '12 AM'
  if (h === 12) return '12 PM'
  return h < 12 ? `${h} AM` : `${h - 12} PM`
}
