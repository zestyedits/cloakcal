/**
 * THE wall-clock label formatter. Three components sliced the same five characters before
 * this existed (agenda, week grid, People preview), and a fourth copy is how a 12-hour
 * format preference would one day update two of them and leave the third lying.
 *
 * String surgery, deliberately: these are LOCAL wall strings, and anything involving
 * `new Date()` reintroduces the host timezone (the documented trap) and throws on an
 * all-day value with no time part.
 */
export const wallTimeLabel = (local: string, allDay = 'All day'): string =>
  local.includes('T') ? local.slice(11, 16) : allDay
