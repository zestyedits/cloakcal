import type { CalendarView } from '@/components/calendar-screen'

/**
 * THE view orderings and labels — one copy, two consumers: the calendar screen's real
 * controls and the root loading fallback's inert chrome. The fallback's whole job is to
 * draw exactly the chrome the screen is about to render, and a second hardcoded list of
 * "which views, in what order, called what" would drift the first time a view is added
 * or renamed — the shell flashing four segments while the screen commits five is
 * precisely the geometry jump the full-shell fallback exists to prevent.
 *
 * Pure and side-effect-free like calendar-links, importable from both sides of the RSC
 * boundary: loading.tsx is a server component and cannot pull values out of the
 * 'use client' screen module, which is why these do not live beside VIEW_KEY_HINTS.
 * (The CalendarView import above is type-only, so there is no runtime cycle.)
 */

export const VIEW_LABELS: Record<CalendarView, string> = {
  agenda: 'Agenda',
  week: 'Week',
  day: 'Day',
  month: 'Month',
}

/** The desktop header's segmented control, left to right. */
export const HEADER_VIEWS = ['agenda', 'week', 'day', 'month'] as const satisfies readonly CalendarView[]

/**
 * The mobile bar's five slots: two views, then the Cloak tile (a sheet, not a view —
 * it stays with its consumers), then two views. Split so the board's "Cloak in the
 * privileged centre" cannot be reflowed by editing one list.
 */
export const NAV_LEADING = ['day', 'week'] as const satisfies readonly CalendarView[]
export const NAV_TRAILING = ['agenda', 'month'] as const satisfies readonly CalendarView[]
