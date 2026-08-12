import { expandSeries, type Occurrence } from '@cloakcal/domain'
import { supabaseServer } from '@/lib/supabase/server'
import { getFixturePage, isDevFixtureEnabled } from './dev-fixture'
import { isoLocalFromUtc } from './local-time'

/**
 * The server read path.
 *
 * Returns Tier A metadata and CIPHERTEXT. Nothing here can decrypt, and nothing here is
 * permitted to import @cloakcal/crypto or @cloakcal/cloak-store — enforced statically by
 * server-boundary.leak.test.ts.
 *
 * Reads run as the signed-in user, never with a service-role key, so Postgres enforces the
 * workspace boundary on every statement. The RLS tests in packages/db therefore cover this
 * path rather than an approximation of it.
 *
 * Recurrence expansion happens here on purpose: occurrence times are Tier A, the server
 * already knows them (plan D1), and expanding once server-side beats shipping an rrule
 * engine's worth of work to every client for every view change.
 *
 * TIMEZONE HAZARD, HANDLED. `events.dtstart_local` is `timestamp without time zone` — a
 * wall-clock reading, not an instant. PostgREST hands it over as a plain string and it stays
 * a string all the way into expandSeries, so the server's own timezone never touches it.
 * The moment someone wraps one of these values in `new Date()`, the DST behaviour ADR 0001
 * specifies quietly stops being true.
 */

export interface CiphertextField {
  readonly fieldName: string
  /** Hex. The client converts to bytes; the server never interprets them. */
  readonly ciphertext: string
  readonly nonce: string
  readonly alg: string
  readonly keyVersion: number
}

export interface CalendarMeta {
  readonly id: string
  readonly colorToken: string
  readonly fields: readonly CiphertextField[]
}

/** One resolved occurrence. Times are Tier A; everything readable is still sealed. */
export interface OccurrenceView {
  readonly eventId: string
  readonly calendarId: string
  readonly occurrenceLocal: string
  readonly start: string
  readonly end: string
  readonly startInstant: string
  readonly allDay: boolean
  readonly busy: 'busy' | 'free' | 'tentative'
  readonly dst: Occurrence['dst']
  readonly fields: readonly CiphertextField[]
  /**
   * Row version, for optimistic concurrency on writes. Tier A — it describes how many times
   * the row changed, not what it says. Only the owner is ever shown it (see audience.ts):
   * an edit counter is a small side channel, and no other audience has a write to guard.
   */
  readonly version: number
  /** True when this occurrence came from an rrule, so delete can say what it will remove. */
  readonly recurring: boolean
  /**
   * The series definition behind this occurrence, for planning a split. Null when the event
   * does not repeat.
   *
   * Tier A throughout — a recurrence rule and an anchor say WHEN, never what. Still
   * owner-only (see audience.ts): "every Tuesday at 09:00 until March" is a shape of
   * somebody's life, and no other audience has a split to plan.
   */
  readonly series: { readonly dtstartLocal: string; readonly rrule: string; readonly durationMinutes: number } | null
}

export interface CalendarPage {
  readonly timezone: string
  readonly from: string
  readonly to: string
  readonly calendars: readonly CalendarMeta[]
  readonly occurrences: readonly OccurrenceView[]
  /**
   * Null in fixture mode, and only there. The page needs it to load the workspace's contacts
   * and visibility rules; returning it here rather than looking the workspace up a second
   * time keeps one definition of "which workspace is this" — the oldest active one.
   */
  readonly workspaceId: string | null
}

export interface CalendarRange {
  readonly from: string
  readonly to: string
}

/** No workspace yet, or no session. An empty page, not an error: the shell still renders. */
export const EMPTY_PAGE = (range: CalendarRange, timezone: string): CalendarPage => ({
  timezone,
  from: range.from,
  to: range.to,
  calendars: [],
  occurrences: [],
  workspaceId: null,
})

interface FieldRow {
  subject_type: string
  subject_id: string
  field_name: string
  ciphertext: string
  nonce: string
  alg: string
  key_version: number
}

interface EventRow {
  id: string
  calendar_id: string
  timezone: string
  all_day: boolean
  dtstart_local: string | null
  start_utc: string
  end_utc: string
  start_date: string | null
  end_date: string | null
  rrule: string | null
  busy: 'busy' | 'free' | 'tentative'
  version: number
}

/** `\x…` hex from PostgREST, stripped to the bare hex the client already expects. */
const hex = (value: string): string => (value.startsWith('\\x') ? value.slice(2) : value)

const toField = (row: FieldRow): CiphertextField => ({
  fieldName: row.field_name,
  ciphertext: hex(row.ciphertext),
  nonce: hex(row.nonce),
  alg: row.alg,
  keyVersion: row.key_version,
})

export async function getCalendarPage(range: CalendarRange, timezone: string): Promise<CalendarPage> {
  // The only branch away from Postgres, and it cannot exist in a production build — the
  // gate checks NODE_ENV, which Next inlines at build time. See dev-fixture.ts.
  if (isDevFixtureEnabled()) return getFixturePage()

  const supabase = await supabaseServer()

  const { data: workspace } = await supabase
    .from('workspaces')
    .select('id')
    .eq('lifecycle', 'active')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle<{ id: string }>()

  if (workspace === null) return EMPTY_PAGE(range, timezone)

  // Fetched together because they are one page of one calendar view; the alternative is a
  // waterfall where the calendar list waits on the event query for no reason.
  const [calendarResult, eventResult, fieldResult, exceptionResult] = await Promise.all([
    supabase
      .from('calendars')
      .select('id, color_token')
      .eq('workspace_id', workspace.id)
      .eq('lifecycle', 'active')
      .order('sort_order', { ascending: true }),
    supabase
      .from('events')
      .select(
        'id, calendar_id, timezone, all_day, dtstart_local, start_utc, end_utc, start_date, end_date, rrule, busy, version',
      )
      .eq('workspace_id', workspace.id)
      .eq('lifecycle', 'active')
      // A series can start long before the window it appears in, so recurring events are
      // never filtered by start time here — expandSeries decides what actually lands in
      // range. Only non-recurring events can be narrowed server-side.
      .or(`rrule.not.is.null,and(start_utc.lt.${range.to},end_utc.gte.${range.from})`),
    supabase
      .from('cloaked_fields')
      .select('subject_type, subject_id, field_name, ciphertext, nonce, alg, key_version')
      .eq('workspace_id', workspace.id),
    // Cancelled and moved occurrences. Loading these is not optional: without them a
    // cancelled occurrence reappears on the next expansion, which reads as the calendar
    // undoing a deletion by itself.
    supabase
      .from('recurrence_exceptions')
      .select('series_id, occurrence_local, kind')
      .eq('workspace_id', workspace.id),
  ])

  if (calendarResult.error !== null) throw calendarResult.error
  if (eventResult.error !== null) throw eventResult.error
  if (fieldResult.error !== null) throw fieldResult.error
  if (exceptionResult.error !== null) throw exceptionResult.error

  const exceptionsBySeries = new Map<string, Array<{ occurrenceLocal: string; kind: 'cancelled' | 'moved' }>>()
  for (const row of (exceptionResult.data ?? []) as Array<{
    series_id: string
    occurrence_local: string
    kind: 'cancelled' | 'moved'
  }>) {
    const bucket = exceptionsBySeries.get(row.series_id) ?? []
    // The key is the ORIGINAL LOCAL occurrence. Normalising it through an instant would
    // change the key across a DST shift and resurrect cancelled occurrences.
    bucket.push({ occurrenceLocal: row.occurrence_local.replace(' ', 'T'), kind: row.kind })
    exceptionsBySeries.set(row.series_id, bucket)
  }

  const fieldsBySubject = new Map<string, CiphertextField[]>()
  for (const row of (fieldResult.data ?? []) as FieldRow[]) {
    const key = `${row.subject_type}:${row.subject_id}`
    const bucket = fieldsBySubject.get(key)
    if (bucket === undefined) fieldsBySubject.set(key, [toField(row)])
    else bucket.push(toField(row))
  }
  const fieldsFor = (type: string, id: string) => fieldsBySubject.get(`${type}:${id}`) ?? []

  const calendars: CalendarMeta[] = ((calendarResult.data ?? []) as Array<{
    id: string
    color_token: string
  }>).map((row) => ({
    id: row.id,
    colorToken: row.color_token,
    fields: fieldsFor('calendar', row.id),
  }))

  const occurrences: OccurrenceView[] = []

  for (const event of (eventResult.data ?? []) as EventRow[]) {
    const fields = fieldsFor('event', event.id)

    if (event.all_day) {
      // Date-only, and never resolved through a timezone (ADR 0001). Storing all-day
      // events as midnight instants is the classic bug that shifts them across zones.
      const startDate = event.start_date
      if (startDate === null) continue
      if (startDate >= range.from.slice(0, 10) && startDate < range.to.slice(0, 10)) {
        occurrences.push({
          eventId: event.id,
          calendarId: event.calendar_id,
          occurrenceLocal: startDate,
          start: startDate,
          end: event.end_date ?? startDate,
          startInstant: `${startDate}T00:00:00Z`,
          allDay: true,
          busy: event.busy,
          dst: 'none',
          fields,
          version: event.version,
          recurring: event.rrule !== null,
          series: null,
        })
      }
      continue
    }

    const dtstartLocal = event.dtstart_local ?? isoLocalFromUtc(event.start_utc, event.timezone)
    const durationMinutes = Math.max(
      1,
      Math.round(
        (new Date(event.end_utc).getTime() - new Date(event.start_utc).getTime()) / 60_000,
      ),
    )

    for (const occurrence of expandSeries(
      { dtstartLocal, durationMinutes, timezone: event.timezone, rrule: event.rrule },
      range,
      exceptionsBySeries.get(event.id) ?? [],
    )) {
      occurrences.push({
        eventId: event.id,
        calendarId: event.calendar_id,
        occurrenceLocal: occurrence.occurrenceLocal,
        start: occurrence.start,
        end: occurrence.end,
        startInstant: occurrence.startInstant,
        allDay: false,
        busy: event.busy,
        dst: occurrence.dst,
        fields,
        version: event.version,
        recurring: event.rrule !== null,
        series:
          event.rrule === null
            ? null
            : { dtstartLocal, rrule: event.rrule, durationMinutes },
      })
    }
  }

  occurrences.sort((a, b) => a.startInstant.localeCompare(b.startInstant))

  return { timezone, from: range.from, to: range.to, calendars, occurrences, workspaceId: workspace.id }
}

