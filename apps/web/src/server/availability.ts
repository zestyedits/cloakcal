import 'server-only'
import { supabaseServer } from '@/lib/supabase/server'
import { isDevFixtureEnabled } from './dev-fixture'

/**
 * Weekly availability, read server-side.
 *
 * The calendar shades the hours outside it, and the shading is drawn during the same render
 * as the grid, so this has to be resolved before anything paints — the same reason
 * `loadWorkspacePrefs` is server-side.
 *
 * WALL-CLOCK MINUTES, NEVER INSTANTS. Everything here is "minutes past local midnight on
 * weekday N", and it stays that across a DST shift, which is the same law recurrence follows
 * (docs/decisions/0001). Nothing in this module or its callers may put one of these numbers
 * through `new Date()`; doing so reintroduces the host timezone and moves somebody's working
 * day by an hour twice a year.
 *
 * TIER A, and the migration header explains why that is allowed: this is times, and times are
 * plaintext by plan D1 because booking and conflict detection need them. It reveals strictly
 * less than `events` already does.
 */

export interface AvailabilityWindow {
  /** Minutes past local midnight. */
  readonly startMinute: number
  readonly endMinute: number
}

/** Weekday (0 = Sunday, matching workspaces.week_start) to its windows, in order. */
export type AvailabilityWeek = Readonly<Record<number, readonly AvailabilityWindow[]>>

export const NO_AVAILABILITY: AvailabilityWeek = {}

/** Mon to Fri, 9 to 5. The demo's schedule, and the shape the editor offers as a starting point. */
export const DEFAULT_WEEK: AvailabilityWeek = {
  1: [{ startMinute: 540, endMinute: 1020 }],
  2: [{ startMinute: 540, endMinute: 1020 }],
  3: [{ startMinute: 540, endMinute: 1020 }],
  4: [{ startMinute: 540, endMinute: 1020 }],
  5: [{ startMinute: 540, endMinute: 1020 }],
}

/**
 * Sort and MERGE a day's windows.
 *
 * Merging is not defensive padding, it is required: `set_availability` refuses overlapping
 * windows, but that check is a data-hygiene rule inside an RPC, not a security boundary. The
 * function is SECURITY INVOKER, so the caller necessarily holds INSERT on the table and can
 * write overlapping rows directly through PostgREST — `availability.test.ts` pins that this is
 * possible and bounded. So the read path must not assume what the write path merely prefers.
 *
 * Touching windows merge too (12:00-13:00 and 13:00-17:00 become 09:00-17:00's neighbour, one
 * band), because two abutting bands of shading with an invisible seam is not information.
 */
export function mergeWindows(
  windows: readonly AvailabilityWindow[],
): readonly AvailabilityWindow[] {
  const sorted = [...windows].sort((a, b) => a.startMinute - b.startMinute)
  const out: AvailabilityWindow[] = []
  for (const window of sorted) {
    const last = out[out.length - 1]
    if (last !== undefined && window.startMinute <= last.endMinute) {
      out[out.length - 1] = {
        startMinute: last.startMinute,
        endMinute: Math.max(last.endMinute, window.endMinute),
      }
    } else {
      out.push(window)
    }
  }
  return out
}

/**
 * The stored week, or an empty one.
 *
 * NO ROWS MEANS NOT SET, not "unavailable" — so an account that has never opened the page
 * gets no shading rather than a calendar shaded end to end, which would look broken.
 *
 * The whole body is guarded. A schedule is decoration on the calendar, and decoration must
 * never be able to 500 the thing it decorates; the degraded answer is "no shading", which is
 * the same answer a brand-new account gets and is therefore already a state the UI handles.
 * That includes the window between a deploy and its migration, the trap `loadWorkspacePrefs`
 * fell into with 0026 by destructuring `data` and dropping the error.
 */
export async function loadAvailability(workspaceId: string | null): Promise<AvailabilityWeek> {
  // Fixture branch FIRST, and it never constructs a Supabase client: CI has no Supabase
  // variables, and `supabaseServer()` throws when it is not configured. Same early return as
  // getCalendarPage and loadPlan.
  if (isDevFixtureEnabled()) return DEFAULT_WEEK
  if (workspaceId === null) return NO_AVAILABILITY

  try {
    const supabase = await supabaseServer()
    const { data, error } = await supabase
      .from('availability_windows')
      .select('weekday, start_minute, end_minute')
      .eq('workspace_id', workspaceId)

    if (error !== null || data === null) return NO_AVAILABILITY

    const byDay = new Map<number, AvailabilityWindow[]>()
    for (const row of data as Array<{
      weekday: number
      start_minute: number
      end_minute: number
    }>) {
      // Clamped rather than trusted, the same discipline loadWorkspacePrefs applies to a
      // column that already has a CHECK behind it.
      if (row.weekday < 0 || row.weekday > 6) continue
      if (row.end_minute <= row.start_minute) continue
      const bucket = byDay.get(row.weekday) ?? []
      bucket.push({ startMinute: row.start_minute, endMinute: row.end_minute })
      byDay.set(row.weekday, bucket)
    }

    const week: Record<number, readonly AvailabilityWindow[]> = {}
    for (const [weekday, windows] of byDay) week[weekday] = mergeWindows(windows)
    return week
  } catch {
    return NO_AVAILABILITY
  }
}

/** `540` to `9:00`. Wall clock, so no zone and no Date. */
export function minuteLabel(minute: number): string {
  const hour24 = Math.floor(minute / 60)
  const minutes = String(minute % 60).padStart(2, '0')
  if (hour24 === 0) return `12:${minutes} AM`
  if (hour24 === 12) return `12:${minutes} PM`
  if (hour24 === 24) return `12:00 AM`
  return hour24 > 12 ? `${hour24 - 12}:${minutes} PM` : `${hour24}:${minutes} AM`
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/**
 * The one-line state for the settings card, e.g. "Mon to Fri, 9:00 AM to 5:00 PM".
 *
 * Collapses to a range only when every open day carries exactly the same single window and
 * those days are contiguous — otherwise it says how many days are open, because a summary
 * that quietly picks one day's hours to stand for a ragged week is worse than a count.
 */
export function describeWeek(week: AvailabilityWeek): string {
  const open = Object.keys(week)
    .map(Number)
    .filter((day) => (week[day]?.length ?? 0) > 0)
    .sort((a, b) => a - b)

  if (open.length === 0) return 'Not set'

  const first = week[open[0]!]!
  const uniform =
    first.length === 1 &&
    open.every((day) => {
      const windows = week[day]!
      return (
        windows.length === 1 &&
        windows[0]!.startMinute === first[0]!.startMinute &&
        windows[0]!.endMinute === first[0]!.endMinute
      )
    })
  const contiguous = open.every((day, index) => index === 0 || day === open[index - 1]! + 1)

  const hours = `${minuteLabel(first[0]!.startMinute)} to ${minuteLabel(first[0]!.endMinute)}`

  if (uniform && contiguous && open.length > 1) {
    return `${DAY_NAMES[open[0]!]} to ${DAY_NAMES[open[open.length - 1]!]}, ${hours}`
  }
  if (uniform && open.length === 1) return `${DAY_NAMES[open[0]!]}, ${hours}`
  return `${open.length} ${open.length === 1 ? 'day' : 'days'} a week`
}
