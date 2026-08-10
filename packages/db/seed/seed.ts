import { cloakField, rootKeyFromSeedBytes, type RootKey } from '@cloakcal/crypto'

/**
 * Seeded mock data.
 *
 * The events mirror the week shown in "Brand Info Concepts.png" (May 18–24) on purpose:
 * when visual work starts at M1, the running app and the reference board show the same
 * calendar, so any divergence is a real divergence rather than different test data.
 *
 * Never seeded from production data (spec §8.6). Everything here is invented.
 *
 * All Tier B content is encrypted with real AES-256-GCM before it reaches the database —
 * there is no development plaintext path any more, and the schema no longer has a type
 * that could express one. The root key below is deterministic ONLY so fixtures can be
 * decrypted by a later test run; it is a test artefact and is never used by the app.
 */

export interface SeedExecutor {
  (sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

export interface SeedResult {
  workspaceId: string
  calendars: Record<CalendarKey, string>
  eventIds: string[]
  seriesId: string
}

type CalendarKey = 'personal' | 'work' | 'private' | 'family'

interface SeedEvent {
  readonly calendar: CalendarKey
  readonly title: string
  readonly location?: string
  readonly notes?: string
  /** Local wall-clock start in the workspace timezone, `YYYY-MM-DDTHH:mm`. */
  readonly start: string
  readonly end: string
  readonly rrule?: string
  readonly busy?: 'busy' | 'free' | 'tentative'
  /** All-day events are date-only; start/end are ignored in favour of these. */
  readonly allDay?: { from: string; to: string }
}

/** Deterministic test key. Fixed bytes, never generated, never shipped. */
export const SEED_ROOT_KEY: RootKey = rootKeyFromSeedBytes(
  new Uint8Array(32).map((_, i) => (i * 7 + 13) % 256),
)

const ANCHOR = '2026-05-18'
const ZONE = 'America/New_York'

const CALENDARS: ReadonlyArray<{
  key: CalendarKey
  name: string
  color: string
  exportPolicy: 'none' | 'busy_only' | 'full'
}> = [
  { key: 'personal', name: 'Personal', color: 'indigo', exportPolicy: 'none' },
  { key: 'work', name: 'Work', color: 'teal', exportPolicy: 'busy_only' },
  // A calendar that must never leave CloakCal, expressed as configuration rather than
  // inferred from how sensitive its events look.
  { key: 'private', name: 'Private', color: 'violet', exportPolicy: 'none' },
  { key: 'family', name: 'Family', color: 'rose', exportPolicy: 'none' },
]

/**
 * A realistic week, including the cases that break naive calendar code: a weekday
 * recurring standup with a cancelled occurrence, a free-busy solo block, an all-day
 * event that must not shift across timezones, and content that must never appear in a
 * Tier A column.
 */
const EVENTS: readonly SeedEvent[] = [
  {
    calendar: 'work',
    title: 'Team Standup',
    location: 'Zoom',
    start: `${ANCHOR}T09:00`,
    end: `${ANCHOR}T09:15`,
    rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
  },
  {
    calendar: 'work',
    title: 'Client Meeting',
    location: 'Office — Room 2',
    notes: 'Renewal discussion. Bring the usage summary.',
    start: '2026-05-19T09:00',
    end: '2026-05-19T10:00',
  },
  {
    calendar: 'personal',
    title: 'Lunch with Sarah',
    location: 'Ivy Cafe',
    start: '2026-05-19T12:00',
    end: '2026-05-19T13:00',
  },
  {
    calendar: 'private',
    title: 'Legal Call',
    notes: 'Sensitive. Do not sync to any external calendar.',
    start: '2026-05-20T13:30',
    end: '2026-05-20T14:30',
  },
  {
    calendar: 'work',
    title: 'Project Review',
    location: 'Zoom',
    start: '2026-05-20T09:00',
    end: '2026-05-20T10:00',
  },
  {
    calendar: 'work',
    title: 'Strategy Session',
    location: 'Office — Boardroom',
    start: '2026-05-21T14:00',
    end: '2026-05-21T15:00',
  },
  {
    calendar: 'personal',
    title: 'Gym',
    start: '2026-05-20T17:00',
    end: '2026-05-20T18:00',
    busy: 'free',
  },
  {
    calendar: 'family',
    title: 'Dinner with Family',
    location: 'Home',
    start: '2026-05-21T19:00',
    end: '2026-05-21T20:30',
  },
  {
    calendar: 'work',
    title: '1:1 with Alex',
    location: 'Zoom',
    start: '2026-05-22T11:00',
    end: '2026-05-22T11:30',
  },
  {
    calendar: 'personal',
    title: 'Offsite',
    start: '2026-05-23T00:00',
    end: '2026-05-24T00:00',
    allDay: { from: '2026-05-23', to: '2026-05-24' },
  },
]

/**
 * May in New York is EDT (UTC-4). Written explicitly rather than inferred: the seed must
 * not depend on the machine's local zone, and a wrong offset here would silently shift
 * every fixture by an hour.
 */
const toUtc = (local: string): string => `${local}:00-04:00`

export async function seedWorkspace(exec: SeedExecutor, userId: string): Promise<SeedResult> {
  const ws = await exec(
    `insert into public.workspaces (owner_id, kind, default_time_visibility, week_start)
     values ($1, 'personal', 'busy', 1) returning id`,
    [userId],
  )
  const workspaceId = ws.rows[0]!['id'] as string

  /** Encrypt then insert. Plaintext never appears in a statement sent to the database. */
  const putCloaked = async (
    subjectType: 'event' | 'calendar' | 'workspace',
    subjectId: string,
    fieldName: string,
    value: string,
  ) => {
    const sealed = await cloakField(SEED_ROOT_KEY, { type: subjectType, id: subjectId }, fieldName, value)
    await exec(
      `insert into public.cloaked_fields
         (subject_type, subject_id, workspace_id, field_name, ciphertext, nonce, alg, key_version)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        subjectType,
        subjectId,
        workspaceId,
        fieldName,
        sealed.ciphertext,
        sealed.nonce,
        sealed.alg,
        sealed.keyVersion,
      ],
    )
  }

  await putCloaked('workspace', workspaceId, 'display_name', 'Keith — Personal')

  const calendars = {} as Record<CalendarKey, string>
  for (const [index, cal] of CALENDARS.entries()) {
    const row = await exec(
      `insert into public.calendars (workspace_id, color_token, sort_order, is_default, export_policy)
       values ($1, $2, $3, $4, $5) returning id`,
      [workspaceId, cal.color, index, index === 0, cal.exportPolicy],
    )
    const calendarId = row.rows[0]!['id'] as string
    calendars[cal.key] = calendarId
    await putCloaked('calendar', calendarId, 'display_name', cal.name)
  }

  const eventIds: string[] = []
  let seriesId = ''

  for (const event of EVENTS) {
    const isSeries = event.rrule !== undefined
    const row = await exec(
      `insert into public.events
         (workspace_id, calendar_id, owner_id, start_utc, end_utc, timezone,
          all_day, start_date, end_date, rrule, dtstart_local, busy, reminder_offsets)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       returning id`,
      [
        workspaceId,
        calendars[event.calendar],
        userId,
        toUtc(event.start),
        toUtc(event.end),
        ZONE,
        event.allDay !== undefined,
        event.allDay?.from ?? null,
        event.allDay?.to ?? null,
        event.rrule ?? null,
        // The local anchor is what makes 09:00 stay 09:00 across a DST boundary.
        isSeries ? event.start.replace('T', ' ') : null,
        event.busy ?? 'busy',
        [10],
      ],
    )
    const eventId = row.rows[0]!['id'] as string
    eventIds.push(eventId)
    if (isSeries) seriesId = eventId

    await putCloaked('event', eventId, 'title', event.title)
    if (event.location) await putCloaked('event', eventId, 'location', event.location)
    if (event.notes) await putCloaked('event', eventId, 'notes', event.notes)
  }

  // One cancelled occurrence, keyed by its ORIGINAL local wall time so a DST shift cannot
  // resurrect it.
  await exec(
    `insert into public.recurrence_exceptions (series_id, workspace_id, occurrence_local, kind)
     values ($1, $2, $3, 'cancelled')`,
    [seriesId, workspaceId, '2026-05-20 09:00'],
  )

  for (const preset of [
    { key: 'full', time: 'exact', fields: { title: 'visible', location: 'visible', notes: 'visible', attendees: 'visible' } },
    { key: 'limited', time: 'exact', fields: { title: 'visible', location: 'hidden', notes: 'hidden', attendees: 'hidden' } },
    { key: 'busy', time: 'busy', fields: { title: 'hidden', location: 'hidden', notes: 'hidden', attendees: 'hidden' } },
    { key: 'hidden', time: 'hidden', fields: { title: 'hidden', location: 'hidden', notes: 'hidden', attendees: 'hidden' } },
  ]) {
    await exec(
      `insert into public.presets (workspace_id, key, is_builtin, time_vis, fields)
       values ($1, $2, true, $3, $4::jsonb)`,
      [workspaceId, preset.key, preset.time, JSON.stringify(preset.fields)],
    )
  }

  return { workspaceId, calendars, eventIds, seriesId }
}

export const SEED_META = {
  anchorMonday: ANCHOR,
  timezone: ZONE,
  eventCount: EVENTS.length,
  seriesCount: EVENTS.filter((e) => e.rrule !== undefined).length,
  allDayCount: EVENTS.filter((e) => e.allDay !== undefined).length,
  calendarCount: CALENDARS.length,
} as const
