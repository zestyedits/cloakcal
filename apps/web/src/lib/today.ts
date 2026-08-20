import type { CalendarView } from '@/components/calendar-screen'

/**
 * "Is the calendar already showing today?" — the predicate behind the header's Today control.
 *
 * PURE, AND IN `lib/` FOR THE USUAL REASON. The phone header turns its date range into the
 * Today action, and that control must not exist when it would be a no-op — a 44px button that
 * navigates to where you already are is worse than no button, because it teaches that the
 * control does nothing. So the decision needs covering, and a decision inside a component that
 * only renders under a fixture cannot be. Same split as `lib/settings-summary.ts`.
 *
 * WHAT "TODAY" MEANS DEPENDS ON THE VIEW, which is the whole reason this is not a string
 * compare. Week and agenda share one fetch and one range, so both are "on today" anywhere in
 * the week containing today; month is the month; day is the day. Getting this wrong in the
 * generous direction hides the control when the user needs it, and in the mean direction shows
 * a button that does nothing.
 *
 * `todayLocal` is supplied rather than read, because "today" is a wall date in the WORKSPACE
 * timezone and this file must not decide what that is. `WeekStrip` and `MiniMonth` both format
 * it with `Intl.DateTimeFormat(..., { timeZone: timezone })`; the caller does the same.
 */

/** Days from Sunday for the calendar's configured first day, 0-6. */
type WeekStart = number

const toUtc = (day: string): number => {
  const [y, m, d] = day.split('-').map(Number)
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)
}

const DAY_MS = 86_400_000

/**
 * The wall date the week containing `day` begins on. UTC arithmetic on a date-only string,
 * never `new Date(day)` — the wall-clock rule in CLAUDE.md is about exactly this: parsing a
 * local date string through the host timezone is how a Monday becomes the previous Sunday for
 * anyone west of UTC.
 */
const startOfWeek = (day: string, weekStart: WeekStart): number => {
  const utc = toUtc(day)
  const weekday = new Date(utc).getUTCDay()
  const back = (weekday - weekStart + 7) % 7
  return utc - back * DAY_MS
}

export function isShowingToday({
  view,
  anchorDate,
  todayLocal,
  weekStart = 0,
}: {
  view: CalendarView
  /** YYYY-MM-DD the view is anchored on. Absent means the server defaulted, which IS today. */
  anchorDate: string | undefined
  /** YYYY-MM-DD for "now" in the workspace timezone. */
  todayLocal: string
  weekStart?: WeekStart
}): boolean {
  /*
   * No anchor means the server chose, and the server chooses today. Treating this as "not
   * today" would put a live Today button on the screen every user lands on first.
   */
  if (anchorDate === undefined) return true

  if (view === 'day') return anchorDate === todayLocal
  // Month is anchored to day 1, so compare the month rather than the date.
  if (view === 'month') return anchorDate.slice(0, 7) === todayLocal.slice(0, 7)

  // agenda and week share one fetch and one range.
  return startOfWeek(anchorDate, weekStart) === startOfWeek(todayLocal, weekStart)
}
