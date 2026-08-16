import 'server-only'
import { Temporal } from '@js-temporal/polyfill'
import {
  holidaysInRange,
  resolveHolidayRegion,
  type Holiday,
  type HolidayMap,
  type HolidayPreference,
  type HolidayRegion,
} from '@cloakcal/domain'

/**
 * Holidays for whatever the page is about to draw, computed on the server.
 *
 * WHY SERVER-SIDE when the computation is pure and could run in the browser. Four surfaces
 * render these — agenda headings, week and day column heads, month cells, the mini month —
 * and every one of them is inside `calendar-screen.tsx`, a single client component. Computing
 * once here and passing a plain object down means the rule tables are evaluated once per
 * navigation instead of once per surface per render, and it keeps the date arithmetic on the
 * same side of the wire as the range arithmetic it has to agree with.
 *
 * It costs nothing privacy-wise and that is worth stating plainly, because "the server
 * computes it" is normally the sentence that starts a leak in this codebase. Nothing about
 * the user is involved: the inputs are a country code and a date, the output is a list of
 * public dates, and the same call with the same inputs returns the same answer for every
 * person on earth. No event, no ciphertext, no key, no row. Rule 2 is untouched — this module
 * imports neither `@cloakcal/crypto` nor `@cloakcal/cloak-store`, and could not use them if
 * it did.
 */

export const NO_HOLIDAYS: HolidayMap = {}

/**
 * How far either side of the anchor to compute.
 *
 * The widest view is the month grid, which spans at most 42 days starting up to 6 days before
 * the 1st — so ±45 would do. Sixty is the same number with room for the mini month and for a
 * view whose window grows later, and the cost of being generous is a few dozen integer
 * comparisons: `holidaysInRange` evaluates a rule table per year, not per day.
 */
const WINDOW_DAYS = 60

export interface ResolvedHolidays {
  /** The region actually drawn, or null when the answer is "none". */
  readonly region: HolidayRegion | null
  readonly byDate: HolidayMap
}

/**
 * The holidays a render needs, and the region it resolved to.
 *
 * `preference` is the stored tri-state and `timezone` is what `auto` consults. Both come
 * from the same prefs object that frames the rest of the page, so a workspace that has moved
 * timezone gets the matching holidays on the same render rather than the next one.
 */
export function resolveHolidays(
  preference: HolidayPreference,
  timezone: string,
  anchorDate: string,
): ResolvedHolidays {
  const region = resolveHolidayRegion(preference, timezone)
  if (region === null) return { region: null, byDate: NO_HOLIDAYS }

  const anchor = Temporal.PlainDate.from(anchorDate)
  const found = holidaysInRange(
    region,
    anchor.subtract({ days: WINDOW_DAYS }).toString(),
    anchor.add({ days: WINDOW_DAYS }).toString(),
  )

  const byDate: Record<string, Holiday[]> = {}
  for (const holiday of found) {
    const bucket = byDate[holiday.date]
    if (bucket === undefined) byDate[holiday.date] = [holiday]
    else bucket.push(holiday)
  }

  return { region, byDate }
}
