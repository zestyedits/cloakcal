import 'server-only'
import { supabaseServer } from '@/lib/supabase/server'
import { isDevFixtureEnabled, getFixtureExportBundle } from './dev-fixture'
import { isoLocalFromUtc } from './local-time'
import type { CiphertextField } from './events'

/**
 * Everything in the account, as SERIES rather than occurrences, for export.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `getCalendarPage`
 * ---------------------------------------------------------------------------
 *
 * Two differences, and both are the point.
 *
 * **No range.** Portability means the whole account. `getCalendarPage` takes a window and
 * narrows non-recurring events server-side, which is right for a calendar view and wrong for
 * an export — a user who exports in May and silently loses last year's events has been given
 * a file that looks complete.
 *
 * **Series, not occurrences.** The calendar expands a rule into dates because that is what a
 * week looks like. An .ics carries the RULE, so the recipient regenerates the same dates
 * themselves — which is the only representation that keeps wall-clock recurrence intact
 * across a DST boundary (ADR 0001). Exporting expanded occurrences would flatten a repeating
 * event into hundreds of unrelated ones and lose the thing that makes it a series.
 *
 * ---------------------------------------------------------------------------
 * THIS RETURNS CIPHERTEXT, AND IT HAS TO
 * ---------------------------------------------------------------------------
 *
 * The server cannot read titles, locations or notes (rule 1, rule 2), so it cannot build the
 * file. It hands over sealed bytes and the browser assembles the .ics after decrypting them.
 * That is exactly what the privacy policy describes — "assembled in your browser from your
 * own decrypted content" — and it is why the export component is `'use client'`.
 */

export interface ExportSeries {
  readonly eventId: string
  readonly calendarId: string
  /** Wall-clock anchor. For an all-day event this is the date, `YYYY-MM-DD`. */
  readonly dtstartLocal: string
  readonly durationMinutes: number
  readonly timezone: string
  readonly rrule: string | null
  readonly allDay: boolean
  readonly busy: 'busy' | 'free' | 'tentative'
  readonly fields: readonly CiphertextField[]
  /** Local wall times of CANCELLED occurrences. Moved ones are separate rows in their own right. */
  readonly exdates: readonly string[]
}

export interface ExportBundle {
  readonly series: readonly ExportSeries[]
  /** The workspace's own zone, used for the file's own metadata rather than per event. */
  readonly timezone: string
}

interface EventRow {
  readonly id: string
  readonly calendar_id: string
  readonly timezone: string
  readonly all_day: boolean
  readonly dtstart_local: string | null
  readonly start_utc: string
  readonly end_utc: string
  readonly start_date: string | null
  readonly end_date: string | null
  readonly rrule: string | null
  readonly busy: 'busy' | 'free' | 'tentative'
}

const EMPTY: ExportBundle = { series: [], timezone: 'UTC' }

/** Whole days are date-only and never resolved through a zone. Same rule as the read path. */
const allDayMinutes = (start: string, end: string | null): number => {
  if (end === null) return 1440
  const days = Math.round(
    (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000,
  )
  return Math.max(1, days) * 1440
}

export async function getExportBundle(): Promise<ExportBundle> {
  // The only branch away from Postgres, and it cannot exist in a production build — the gate
  // checks NODE_ENV, which Next inlines at build time. See dev-fixture.ts.
  if (isDevFixtureEnabled()) return getFixtureExportBundle()

  const supabase = await supabaseServer()

  const { data: workspace } = await supabase
    .from('workspaces')
    .select('id, timezone')
    .eq('lifecycle', 'active')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle<{ id: string; timezone: string | null }>()

  if (workspace === null) return EMPTY

  const [eventResult, fieldResult, exceptionResult] = await Promise.all([
    // NO range filter, unlike getCalendarPage. Every active event in the account.
    supabase
      .from('events')
      .select(
        'id, calendar_id, timezone, all_day, dtstart_local, start_utc, end_utc, start_date, end_date, rrule, busy',
      )
      .eq('workspace_id', workspace.id)
      .eq('lifecycle', 'active')
      .order('start_utc', { ascending: true }),
    supabase
      .from('cloaked_fields')
      .select('subject_type, subject_id, field_name, ciphertext, nonce, alg, key_version')
      .eq('workspace_id', workspace.id)
      .eq('subject_type', 'event'),
    // Cancelled occurrences become EXDATE. Without them a deleted occurrence reappears in the
    // exported file, which is the same defect as it reappearing in the app.
    supabase
      .from('recurrence_exceptions')
      .select('series_id, occurrence_local, kind')
      .eq('workspace_id', workspace.id)
      .eq('kind', 'cancelled'),
  ])

  // Every one throws rather than returning a partial file. An export that quietly omits a
  // year of events is worse than an export that fails, because it looks like it worked.
  if (eventResult.error !== null) throw eventResult.error
  if (fieldResult.error !== null) throw fieldResult.error
  if (exceptionResult.error !== null) throw exceptionResult.error

  const fieldsByEvent = new Map<string, CiphertextField[]>()
  for (const row of (fieldResult.data ?? []) as Array<{
    subject_id: string
    field_name: string
    ciphertext: string
    nonce: string
    alg: string
    key_version: number
  }>) {
    const bucket = fieldsByEvent.get(row.subject_id) ?? []
    bucket.push({
      fieldName: row.field_name,
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      alg: row.alg,
      keyVersion: row.key_version,
    })
    fieldsByEvent.set(row.subject_id, bucket)
  }

  const exdatesBySeries = new Map<string, string[]>()
  for (const row of (exceptionResult.data ?? []) as Array<{
    series_id: string
    occurrence_local: string
  }>) {
    const bucket = exdatesBySeries.get(row.series_id) ?? []
    // The ORIGINAL local occurrence, space-separated out of Postgres. Normalising it through
    // an instant would move the key across a DST shift and resurrect a cancelled occurrence.
    bucket.push(row.occurrence_local.replace(' ', 'T'))
    exdatesBySeries.set(row.series_id, bucket)
  }

  const series: ExportSeries[] = []

  for (const event of (eventResult.data ?? []) as EventRow[]) {
    const shared = {
      eventId: event.id,
      calendarId: event.calendar_id,
      timezone: event.timezone,
      rrule: event.rrule,
      busy: event.busy,
      fields: fieldsByEvent.get(event.id) ?? [],
      exdates: exdatesBySeries.get(event.id) ?? [],
    }

    if (event.all_day) {
      if (event.start_date === null) continue
      series.push({
        ...shared,
        allDay: true,
        dtstartLocal: event.start_date,
        durationMinutes: allDayMinutes(event.start_date, event.end_date),
      })
      continue
    }

    series.push({
      ...shared,
      allDay: false,
      dtstartLocal: event.dtstart_local ?? isoLocalFromUtc(event.start_utc, event.timezone),
      durationMinutes: Math.max(
        1,
        Math.round((Date.parse(event.end_utc) - Date.parse(event.start_utc)) / 60_000),
      ),
    })
  }

  return { series, timezone: workspace.timezone ?? 'UTC' }
}
