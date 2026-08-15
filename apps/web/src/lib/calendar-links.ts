import { Temporal } from '@js-temporal/polyfill'
import type { CalendarView } from '@/components/calendar-screen'

/**
 * THE query builders for calendar navigation — one implementation, three kinds of caller:
 * the server page's steppers, the client screen's view switch and Today link, and the
 * hotkey layer. The Today-from-week bug existed because two builders disagreed about
 * when `view` was carried; a single module is how that class of bug stays fixed.
 *
 * Pure string-in string-out: no 'use client', no I/O, importable from both sides of the
 * RSC boundary. Queries carry ids, dates and view names only — nothing decrypted can
 * enter a URL through here (rule 2's URL clause, by construction).
 *
 * EVERY builder emits `view`, INCLUDING for agenda, and that is not tidiness — it is the
 * fix for a live bug. All three used to omit it when the target was agenda, on the
 * reasoning that the server falls back to agenda anyway so the param was noise. Migration
 * 0022 made that false: `page.tsx` now resolves an absent `view` to the workspace's stored
 * `default_view`. With a stored default of month, a link built for AGENDA carried no view,
 * the server read the absent param as month, and clicking Agenda left the user on Month —
 * the same for Today and the `t` hotkey. Agenda and week hid it between them, because that
 * pair is a client toggle that never consults the URL, which is why it survived review.
 *
 * So the rule is now unconditional: the view a link means is the view a link says. A
 * shorter URL is not worth a view nobody can reach.
 */

/** Land on a view, keeping the anchor and the audience. */
export function viewQuery(
  target: CalendarView,
  anchorDate: string | undefined,
  audience: string,
): Record<string, string> {
  const query: Record<string, string> = {}
  if (anchorDate !== undefined) query['date'] = anchorDate
  query['view'] = target
  if (audience !== 'owner') query['as'] = audience
  return query
}

/**
 * Step the anchor by one unit of the current view. Month steps pin to day 1 first, so
 * ±1 from Jan 31 lands on Feb 1 and repeated steps cannot drift through short months.
 */
export function stepQuery(
  anchorDate: string,
  view: CalendarView,
  step: number,
  audience: string,
): Record<string, string> {
  const anchor = Temporal.PlainDate.from(anchorDate)
  const shifted =
    view === 'day'
      ? anchor.add({ days: step })
      : view === 'month'
        ? anchor.with({ day: 1 }).add({ months: step })
        : anchor.add({ days: 7 * step })
  const query: Record<string, string> = { date: shifted.toString(), view }
  // Carried so View As survives navigation; dropping it would silently return a
  // reviewer to the owner's view mid-check.
  if (audience !== 'owner') query['as'] = audience
  return query
}

/**
 * Back to now: no date (the server defaults to today), the VIEW kept. Omitting the view
 * for the week toggle is the exact bug this module exists to pin down, and omitting it
 * for agenda was the second helping of the same mistake — see the header.
 */
export function todayQuery(view: CalendarView, audience: string): Record<string, string> {
  const query: Record<string, string> = { view }
  if (audience !== 'owner') query['as'] = audience
  return query
}
