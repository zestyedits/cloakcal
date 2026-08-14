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
 */

/** Land on a view, keeping the anchor and the audience. */
export function viewQuery(
  target: CalendarView,
  anchorDate: string | undefined,
  audience: string,
): Record<string, string> {
  const query: Record<string, string> = {}
  if (anchorDate !== undefined) query['date'] = anchorDate
  if (target !== 'agenda') query['view'] = target
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
  const query: Record<string, string> = { date: shifted.toString() }
  if (view !== 'agenda') query['view'] = view
  // Carried so View As survives navigation; dropping it would silently return a
  // reviewer to the owner's view mid-check.
  if (audience !== 'owner') query['as'] = audience
  return query
}

/**
 * Back to now: no date (the server defaults to today), the VIEW kept. Omitting the view
 * for the week toggle is the exact bug this module exists to pin down.
 */
export function todayQuery(view: CalendarView, audience: string): Record<string, string> {
  const query: Record<string, string> = {}
  if (view !== 'agenda') query['view'] = view
  if (audience !== 'owner') query['as'] = audience
  return query
}
