/**
 * Generates the M1 dev fixture: Tier A metadata plus real ciphertext.
 *
 * Run with `node tools/generate-fixture.ts` (Node 24 strips types natively).
 *
 * WHY A GENERATOR AND NOT A SERVER MODULE. The server must never import the crypto
 * package — that is the static rule in server-boundary.leak.test.ts. So the fixture is
 * encrypted here, at author time, and committed as hex. The server then reads inert JSON
 * and hands ciphertext to the client, exactly as the real Supabase read path will.
 *
 * This file lives outside apps/ deliberately: putting it under apps/web/scripts would
 * have forced an exclusion in the static rule, and a rule with holes in it is a rule
 * people stop trusting.
 */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { cloakField, rootKeyFromSeedBytes } from '@cloakcal/crypto'

/** Matches DEV_ROOT_KEY_SEED in apps/web/src/lib/dev-key.ts. Development only. */
const DEV_KEY = rootKeyFromSeedBytes(new Uint8Array(32).map((_, i) => (i * 31 + 7) % 256))

const ZONE = 'America/New_York'
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

const CALENDARS = [
  { id: 'c0000000-0000-4000-8000-000000000001', colorToken: 'indigo', name: 'Personal' },
  { id: 'c0000000-0000-4000-8000-000000000002', colorToken: 'teal', name: 'Work' },
  { id: 'c0000000-0000-4000-8000-000000000003', colorToken: 'violet', name: 'Private' },
  { id: 'c0000000-0000-4000-8000-000000000004', colorToken: 'rose', name: 'Family' },
  // A distinctive name on purpose. "Personal", "Work", "Private" and "Family" are useless
  // as leak canaries: they collide with framework identifiers (fontFamily) and with our
  // own placeholder copy ("Private event"). At least one calendar display name must be
  // unambiguous, or calendar-name leakage cannot be detected at all.
  { id: 'c0000000-0000-4000-8000-000000000005', colorToken: 'indigo', name: 'Bramblewick Trust' },
] as const

interface FixtureEvent {
  id: string
  calendarIndex: number
  startLocal: string
  durationMinutes: number
  rrule: string | null
  busy: 'busy' | 'free' | 'tentative'
  allDay?: { startDate: string; endDate: string }
  title: string
  location?: string
  notes?: string
}

/** The week from the brand board, so the running app and the reference show the same data. */
const EVENTS: FixtureEvent[] = [
  { id: 'e0000000-0000-4000-8000-000000000001', calendarIndex: 1, startLocal: '2026-05-18T09:00:00', durationMinutes: 15, rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', busy: 'busy', title: 'Team Standup', location: 'Zoom' },
  { id: 'e0000000-0000-4000-8000-000000000002', calendarIndex: 1, startLocal: '2026-05-19T09:00:00', durationMinutes: 60, rrule: null, busy: 'busy', title: 'Client Meeting', location: 'Office — Room 2', notes: 'Renewal discussion. Bring the usage summary.' },
  { id: 'e0000000-0000-4000-8000-000000000003', calendarIndex: 0, startLocal: '2026-05-19T12:00:00', durationMinutes: 60, rrule: null, busy: 'busy', title: 'Lunch with Sarah', location: 'Ivy Cafe' },
  { id: 'e0000000-0000-4000-8000-000000000004', calendarIndex: 2, startLocal: '2026-05-20T13:30:00', durationMinutes: 60, rrule: null, busy: 'busy', title: 'Legal Call', notes: 'Sensitive. Do not sync to any external calendar.' },
  { id: 'e0000000-0000-4000-8000-000000000005', calendarIndex: 1, startLocal: '2026-05-20T09:00:00', durationMinutes: 60, rrule: null, busy: 'busy', title: 'Project Review', location: 'Zoom' },
  { id: 'e0000000-0000-4000-8000-000000000006', calendarIndex: 1, startLocal: '2026-05-21T14:00:00', durationMinutes: 60, rrule: null, busy: 'busy', title: 'Strategy Session', location: 'Office — Boardroom' },
  { id: 'e0000000-0000-4000-8000-000000000007', calendarIndex: 0, startLocal: '2026-05-20T17:00:00', durationMinutes: 60, rrule: null, busy: 'free', title: 'Gym' },
  { id: 'e0000000-0000-4000-8000-000000000008', calendarIndex: 3, startLocal: '2026-05-21T19:00:00', durationMinutes: 90, rrule: null, busy: 'busy', title: 'Dinner with Family', location: 'Home' },
  { id: 'e0000000-0000-4000-8000-000000000009', calendarIndex: 1, startLocal: '2026-05-22T11:00:00', durationMinutes: 30, rrule: null, busy: 'busy', title: '1:1 with Alex', location: 'Zoom' },
  { id: 'e0000000-0000-4000-8000-00000000000b', calendarIndex: 4, startLocal: '2026-05-22T15:00:00', durationMinutes: 45, rrule: null, busy: 'busy', title: 'Bramblewick handover', location: 'Quarrystone Room', notes: 'Marchpane clause needs redrafting.' },
  { id: 'e0000000-0000-4000-8000-00000000000a', calendarIndex: 0, startLocal: '2026-05-23T00:00:00', durationMinutes: 0, rrule: null, busy: 'free', allDay: { startDate: '2026-05-23', endDate: '2026-05-24' }, title: 'Offsite' },
]

const seal = async (type: 'event' | 'calendar', id: string, fieldName: string, value: string) => {
  const p = await cloakField(DEV_KEY, { type, id }, fieldName, value)
  return {
    fieldName,
    ciphertext: hex(p.ciphertext),
    nonce: hex(p.nonce),
    alg: p.alg,
    keyVersion: p.keyVersion,
  }
}

// May in New York is EDT (UTC-4). Explicit rather than inferred from the host.
const toUtc = (local: string, addMinutes = 0) =>
  new Date(new Date(`${local}-04:00`).getTime() + addMinutes * 60_000).toISOString()

const fixture = {
  note: 'DEVELOPMENT FIXTURE. Tier A metadata plus real AES-256-GCM ciphertext. No plaintext.',
  timezone: ZONE,
  calendars: await Promise.all(
    CALENDARS.map(async (c) => ({
      id: c.id,
      colorToken: c.colorToken,
      fields: [await seal('calendar', c.id, 'display_name', c.name)],
    })),
  ),
  events: await Promise.all(
    EVENTS.map(async (e) => {
      const fields = [await seal('event', e.id, 'title', e.title)]
      if (e.location) fields.push(await seal('event', e.id, 'location', e.location))
      if (e.notes) fields.push(await seal('event', e.id, 'notes', e.notes))

      return {
        id: e.id,
        calendarId: CALENDARS[e.calendarIndex]!.id,
        timezone: ZONE,
        startUtc: toUtc(e.startLocal),
        endUtc: toUtc(e.startLocal, e.durationMinutes),
        durationMinutes: e.durationMinutes,
        dtstartLocal: e.rrule === null ? null : e.startLocal,
        rrule: e.rrule,
        allDay: e.allDay ?? null,
        busy: e.busy,
        fields,
      }
    }),
  ),
}

const out = fileURLToPath(new URL('../apps/web/src/server/events.fixture.json', import.meta.url))
await writeFile(out, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8')

// Fail loudly if any plaintext made it into the serialized output.
const serialized = JSON.stringify(fixture)
const canaries = EVENTS.flatMap((e) => [e.title, e.location, e.notes]).filter(
  (v): v is string => typeof v === 'string',
)
const leaked = canaries.filter((c) => serialized.includes(c))
if (leaked.length > 0) {
  throw new Error(`Fixture generator leaked plaintext: ${leaked.join(', ')}`)
}

console.log(`Wrote ${out}`)
console.log(`${fixture.events.length} events, ${fixture.calendars.length} calendars, no plaintext.`)
