'use client'

import { useMemo } from 'react'
import { PRIVACY_LEVELS } from '@cloakcal/ui'
import { primaryHoliday, type HolidayMap } from '@cloakcal/domain'
import type { AvailabilityWeek } from '@/server/availability'
import type { DisclosureLevel } from '@cloakcal/policy'
import type { RedactedOccurrence } from '@/server/audience'
import type { DeletedEvent, SavedEvent } from '@/lib/saved-event'
import { CloakedText } from './cloaked-text'
import { EditableEvent } from './editable-event'
import { Icon, type IconName } from './ui/icons'
import Link from 'next/link'
import { wallTimeLabel } from '@/lib/wall-time'
import { viewQuery } from '@/lib/calendar-links'
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
  /** Column index and count WITHIN THIS CLUSTER, for events that overlap in time. */
  readonly lane: number
  readonly lanes: number
  /** Which cluster of mutually-overlapping events this belongs to, within its day. */
  readonly cluster: number
}

/**
 * A run of mutually-overlapping events, summarised. One per cluster, whatever its size.
 *
 * The grid renders this INSTEAD of the cluster's blocks wherever a lane would be too narrow
 * to hold a title — see `.clusterBlock` in the stylesheet for where that line is drawn and
 * why it is drawn in CSS rather than here.
 */
interface Cluster {
  readonly id: number
  readonly size: number
  readonly lanes: number
  readonly top: number
  readonly height: number
  /** Wall-clock strings, for the label and the accessible name. */
  readonly startsAt: string
  readonly endsAt: string
}

/**
 * Lay out one day's events so overlaps sit side by side.
 *
 * Greedy interval colouring: sweep in start order and reuse the first lane whose previous
 * event has ended. It is not the tightest possible packing, but it is stable — the same
 * events always land in the same lanes, so a re-render never shuffles the layout under the
 * user's cursor. A cleverer algorithm that moved events around on every render would be a
 * worse calendar.
 *
 * LANES ARE PER CLUSTER, AND THEY USED TO BE PER DAY. That was a real defect and not a
 * subtlety: `lanes` was the total number of lane slots ever allocated across the whole
 * sweep, written into every occurrence, so ONE 09:00-17:00 all-hands made every other event
 * that day render at half width — including a 19:00 dinner that overlapped nothing. The
 * sweep now closes a cluster whenever an event starts at or after the running maximum end,
 * and each cluster sizes its own lanes. An isolated event is `lanes: 1` and takes the
 * column, which is what it always should have done.
 *
 * The clusters are returned as well as the placements, because an aggregate needs the
 * cluster's own extent and count and the old shape threw both away.
 */
function layout(
  day: readonly RedactedOccurrence[],
  startMinute: number,
  span: number,
): { placed: Placed[]; clusters: Cluster[] } {
  const sorted = [...day].sort((a, b) => minutesOf(a.start) - minutesOf(b.start))

  interface Span {
    occurrence: RedactedOccurrence
    from: number
    to: number
  }
  const groups: Span[][] = []
  let openEnd = -1

  for (const occurrence of sorted) {
    const from = minutesOf(occurrence.start)
    // An end that is not after the start means an overnight or zero-length event; give it a
    // legible minimum rather than a zero-height sliver nobody can tap.
    const rawTo = minutesOf(occurrence.end)
    const to = rawTo > from ? rawTo : from + 30

    // A gap at or beyond the running maximum end closes the cluster. `>=` and not `>`:
    // an event starting exactly when the last one ends does not overlap it.
    if (groups.length === 0 || from >= openEnd) {
      groups.push([])
      openEnd = to
    } else {
      openEnd = Math.max(openEnd, to)
    }
    groups[groups.length - 1]!.push({ occurrence, from, to })
  }

  const placed: Placed[] = []
  const clusters: Cluster[] = []

  groups.forEach((group, id) => {
    // Fresh lanes per cluster: that reset IS the fix described above.
    const laneEnds: number[] = []
    const laneOf = group.map(({ from, to }) => {
      let lane = laneEnds.findIndex((end) => end <= from)
      if (lane === -1) {
        lane = laneEnds.length
        laneEnds.push(to)
      } else {
        laneEnds[lane] = to
      }
      return lane
    })
    const lanes = Math.max(1, laneEnds.length)

    let first = group[0]!
    let last = group[0]!
    for (const item of group) {
      if (item.from < first.from) first = item
      if (item.to > last.to) last = item
    }

    group.forEach((item, index) => {
      placed.push({
        occurrence: item.occurrence,
        top: ((item.from - startMinute) / span) * 100,
        height: Math.max(((item.to - item.from) / span) * 100, 2.5),
        lane: laneOf[index]!,
        lanes,
        cluster: id,
      })
    })

    clusters.push({
      id,
      size: group.length,
      lanes,
      top: ((first.from - startMinute) / span) * 100,
      height: Math.max(((last.to - first.from) / span) * 100, 2.5),
      startsAt: first.occurrence.start,
      endsAt: last.occurrence.end,
    })
  })

  return { placed, clusters }
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
  onSaved,
  onDeleted,
  savedEventId = null,
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
  /** Forwarded to each block's edit sheet, the same way onOpenVisibility already is. */
  onSaved?: ((result: SavedEvent) => void) | undefined
  /** Forwarded to each block's Delete flow, so a delete from the grid can be undone. */
  onDeleted?: ((info: DeletedEvent) => void) | undefined
  /**
   * The event just written, so its block can wear the saved ring. A prop rather than a
   * context because that is how every other screen-level concern reaches this grid.
   */
  savedEventId?: string | null
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
      {/*
        `data-single` is the day view, and the CSS uses it to drop the column head on a
        phone -- where `WeekStrip` sits directly above this grid already ringing the same
        date, so "THU 20" is the second of two identical answers in 60px of screen. It is
        an attribute rather than a `dayCount === 1` branch in JSX because the decision is a
        VIEWPORT one: at 900px the strip hides itself and this head becomes the only date
        on the screen, so React must not be the thing that removes it.
      */}
      <div
        className={styles.grid}
        data-single={days.length === 1 || undefined}
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
                        onSaved={onSaved}
                        onDeleted={onDeleted}
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
          const { placed, clusters } = layout(byDay.get(day) ?? [], startMinute, span)

          /*
           * HOW MANY LANES THIS SURFACE CAN HOLD BEFORE A TITLE STOPS FITTING.
           *
           * The only thing JS needs to know is how many day columns are on screen, which it
           * does. A phone scroller is ~343px; the gutter takes 52 and the peek 20, so:
           *
           *   seven columns, three visible -> ~95px each -> ONE lane fits (72px is the floor)
           *   one column                   -> ~291px     -> THREE lanes fit
           *
           * So the week folds any overlap and the day folds only a four-way pile-up -- which
           * is also what makes the day view an honest destination for the week's aggregate
           * rather than a surface that folds again on arrival.
           *
           * Whether folding applies AT ALL is still the stylesheet's call, gated on the
           * breakpoint: a desktop column is wide enough to lane an overlap and keep both
           * titles, and blanking those was a desktop regression bought by a mobile pass once
           * already.
           */
          const laneBudget = days.length === 1 ? 3 : 1
          const folded = new Set(
            clusters.filter((cluster) => cluster.lanes > laneBudget).map((cluster) => cluster.id),
          )

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
                    // The name describes the CELL, and the sheet then shows the value it
                    // actually resolved -- see slotMinute for why those are not the same
                    // sentence and why that is honest rather than a lie.
                    aria-label={`New event on ${day} at ${formatHour(hour)}`}
                    onClick={(event) =>
                      onComposeSlot(
                        day,
                        `${String(((hour % 24) + 24) % 24).padStart(2, '0')}:${slotMinute(event)}`,
                      )
                    }
                  />
                ),
              )}

              {/*
                THE AGGREGATE, one per cluster of overlapping events.
                ------------------------------------------------------------------------
                Rendered ALONGSIDE the cluster's blocks, not instead of them, and the
                stylesheet decides which of the two is shown. That split is deliberate:
                "is a lane wide enough for a title" is a question about the rendered column,
                which only CSS knows, and answering it in JS would mean re-deriving the
                column arithmetic from `100cqi` in a second place. It also avoids the
                hydration swap a `matchMedia` read would cause -- 42 blocks reflowing after
                first paint is the trap the month cells were shaped around.

                WHY IT EXISTS AT ALL. A phone week column is ~95px, so a single overlap
                leaves each block ~27px of content box: four characters. The pass before this
                one dropped the text at that width and left a bare coloured rectangle, which
                is not an event -- the calendar colours name a SOURCE, not a meaning, so
                colour plus position cannot identify anything. A block now either carries a
                legible title or is folded into an honest count.

                NO CALENDAR COLOUR. `redactPage` withholds `calendarId` on a busy occurrence
                precisely because grouping is itself a disclosure, so an aggregate tinted
                from its members would leak the grouping the redactor refused to send.

                NO PRIVACY CHIP. It summarises events whose levels may differ, and the widest
                would misdescribe the narrowest.
              */}
              {clusters.map((cluster) => {
                const from = wallTimeLabel(cluster.startsAt, '')
                const to = wallTimeLabel(cluster.endsAt, '')
                /*
                 * "2 events" IS PRINTED AND "2 overlapping events" IS SPOKEN, because the
                 * printed one has to fit. A phone column is ~95px, or 79px of content box,
                 * and "2 overlapping events" at --text-xs rendered as "2 overlap..." -- an
                 * aggregate that truncates is the defect it was built to remove.
                 *
                 * Nothing is lost by the shorter spelling: a single block spanning one slot
                 * and saying "2 events" can only mean two events in that slot, and the range
                 * underneath states which slot. WCAG 2.5.3 holds because the accessible name
                 * CONTAINS the visible text -- "2 events" is a prefix of neither, so the
                 * count and the noun are kept adjacent in both.
                 */
                const shown = `${cluster.size} events`
                const spoken = `${cluster.size} overlapping events`
                // The next surface with more room for this day: a week column opens the day
                // view, and the day view -- already one full-width column -- opens the
                // agenda, which is a list and so terminates at any density.
                const target = days.length === 1 ? 'agenda' : 'day'
                const href = {
                  pathname: '/' as const,
                  // `audience` is optional on this component and `viewQuery` omits `as` for
                  // the owner anyway, so an absent one is the owner's own view.
                  query: viewQuery(target, day, audience ?? 'owner'),
                }
                return (
                  <Link
                    key={`cluster-${day}-${cluster.id}`}
                    className={styles.clusterBlock}
                    data-fold={folded.has(cluster.id) || undefined}
                    href={href}
                    /* Count, extent, destination. Every part of it is derived from what the
                       server sent for the ACTIVE audience -- `redactPage` has already dropped
                       everything withheld, so this number cannot exceed what the viewer is
                       entitled to know. */
                    aria-label={`${spoken}, ${from} to ${to}, open ${day}`}
                    style={{ top: `${cluster.top}%`, height: `${cluster.height}%` }}
                  >
                    <span className={styles.clusterCount}>{shown}</span>
                    {/*
                      THE START ONLY, PRINTED; THE RANGE, SPOKEN.
                      ------------------------------------------------------------------
                      Not a space concession, though it began as one -- "09:00-10:00" is
                      79px of a 77px box in the numeral face. It is the consistent answer:
                      NO block in this grid prints an end time. `.eventTime` is
                      `wallTimeLabel(occurrence.start)` and always has been, because the
                      block's HEIGHT is its extent -- that is what a time grid is for. An
                      aggregate printing an end would be the only element here restating
                      what the geometry already says.
                      The accessible name carries the full range, because a screen reader
                      gets no geometry.
                    */}
                    <span className={styles.clusterRange}>{from}</span>
                  </Link>
                )
              })}
              {placed.map(({ occurrence, top, height, lane, lanes, cluster }) => {
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
                    /* The stylesheet hides a folded cluster's blocks on a phone and shows
                       the aggregate instead; on desktop the reverse. One DOM either way, so
                       nothing reflows after hydration. `data-lanes` is kept because it is
                       what an e2e assertion reads to prove a lone event still takes its
                       whole column. */
                    data-lanes={lanes}
                    data-fold={folded.has(cluster) || undefined}
                    data-color={colorFor(occurrence.calendarId)}
                    data-time={occurrence.time}
                    data-busy={occurrence.busy ?? 'busy'}
                    data-just-saved={occurrence.eventId === savedEventId || undefined}
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
                        onSaved={onSaved}
                        onDeleted={onDeleted}
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

/**
 * Which half of the hour a click landed in, as `00` or `30`.
 *
 * WHY NOT TWO BUTTONS PER HOUR. Splitting the cell would put 182 controls on the densest
 * surface in the app, for a week people mostly read rather than click. Reading the position
 * keeps the count at 91 and costs nothing.
 *
 * WHY HALVES AND NOT QUARTERS. Quarters were the first attempt and they are over-precise for
 * a single click: nobody aims at 9:15, and the extra resolution only widens the gap between
 * what the control is NAMED and what it does.
 *
 * WHY THE MIDPOINT BELONGS TO THE HOUR, which is the part worth keeping. The cell's
 * accessible name is "New event on Tuesday at 9 AM", so the AMBIGUOUS case has to resolve to
 * 9 AM or the name is a lie in exactly the situation where the user had no strong intent.
 * `<= 0.5` is therefore deliberate rather than an off-by-one: the upper half INCLUDING dead
 * centre is the hour, and only a clearly low click asks for the half hour. Caught by the
 * compose spec, which clicks element centres and started producing 9:30 for a test named
 * "composes at that day and hour".
 *
 * `detail === 0` is a keyboard or assistive activation, with no pointer position to read at
 * all; those land on :00, exactly what the name promises. Either way the sheet then shows the
 * resolved time in an editable field, so nothing is written that was not confirmed on screen.
 */
function slotMinute(event: React.MouseEvent<HTMLButtonElement>): string {
  if (event.detail === 0) return '00'
  const rect = event.currentTarget.getBoundingClientRect()
  if (rect.height === 0) return '00'
  return (event.clientY - rect.top) / rect.height > 0.5 ? '30' : '00'
}

/** 12-hour labels without the minutes, which are noise in an hour gutter. */
function formatHour(hour: number): string {
  const h = ((hour % 24) + 24) % 24
  if (h === 0) return '12 AM'
  if (h === 12) return '12 PM'
  return h < 12 ? `${h} AM` : `${h - 12} PM`
}
