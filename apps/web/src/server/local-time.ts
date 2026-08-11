/**
 * Render a UTC instant as local wall time in a zone.
 *
 * Intl rather than Date arithmetic, and the result is a string rather than a Date, for the
 * same reason the CRUD read path asks Postgres for text: the host machine's timezone must
 * never influence the answer. A `new Date()` anywhere in this path reintroduces exactly the
 * bug that made a 09:00 event read as 17:00 during M1.
 *
 * Only needed for events with no `dtstart_local` — single timed events written before the
 * local anchor existed, and the two fixture rows that still exercise that shape.
 */
export function isoLocalFromUtc(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(instant))

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`
}
