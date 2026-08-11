import { describe, expect, it } from 'vitest'
import { redactPage, type AudienceId } from '../src/server/audience.js'
import type { CalendarPage, OccurrenceView } from '../src/server/events.js'

/**
 * `version` and `recurring` are the two Tier A facts the delete control needs, and the only
 * two fields on an occurrence that exist for the owner alone.
 *
 * Neither is content, so leaking one would not expose a title. It would still be a
 * regression: an edit counter tells a viewer how often an event has been rearranged, which
 * is a small signal about someone's week that they never chose to share. And no other
 * audience has a write for the version to guard, so there is no cost to withholding it.
 *
 * The failure this guards against is quiet. `redactPage` spreads the policy engine's output
 * into each occurrence, so the day the engine starts returning a wider object, these fields
 * would begin reaching every audience with nothing to announce it.
 */

const occurrence = (id: string, version: number, recurring: boolean): OccurrenceView => ({
  eventId: id,
  calendarId: 'cal-1',
  occurrenceLocal: '2026-05-19T09:00:00',
  start: '2026-05-19T09:00:00',
  end: '2026-05-19T09:30:00',
  startInstant: '2026-05-19T13:00:00Z',
  allDay: false,
  busy: 'busy',
  dst: 'none',
  fields: [
    {
      fieldName: 'title',
      ciphertext: 'aa'.repeat(24),
      nonce: 'bb'.repeat(12),
      alg: 'aes-256-gcm-v1',
      keyVersion: 1,
    },
  ],
  version,
  recurring,
})

const page: CalendarPage = {
  timezone: 'America/New_York',
  from: '2026-05-18T00:00:00Z',
  to: '2026-05-25T00:00:00Z',
  calendars: [{ id: 'cal-1', colorToken: 'indigo', fields: [] }],
  occurrences: [occurrence('event-1', 7, true), occurrence('event-2', 1, false)],
}

const NOW = '2026-05-18T12:00:00Z'

describe('delete metadata is owner-only', () => {
  it('gives the owner the version and recurrence flag it needs to delete', () => {
    const redacted = redactPage(page, 'owner', NOW)

    expect(redacted.occurrences).toHaveLength(2)
    expect(redacted.occurrences.map((o) => [o.version, o.recurring])).toEqual([
      [7, true],
      [1, false],
    ])
  })

  // Sarah can see titles, so her occurrences survive redaction with content attached. That
  // makes her the audience most likely to be handed these fields by accident.
  it.each<AudienceId>(['contact:sarah', 'contact:alex', 'public'])(
    'withholds both from %s',
    (audience) => {
      const redacted = redactPage(page, audience, NOW)

      for (const shown of redacted.occurrences) {
        expect(shown.version).toBeUndefined()
        expect(shown.recurring).toBeUndefined()
        // `undefined` is not enough on its own: an explicitly-present key set to undefined
        // still serialises into the RSC payload as a key. It must not be there at all.
        expect(Object.hasOwn(shown, 'version')).toBe(false)
        expect(Object.hasOwn(shown, 'recurring')).toBe(false)
      }
    },
  )

  it('is not a vacuous test — sarah does receive occurrences to check', () => {
    // Without this, the loop above would pass trivially the day redaction started
    // withholding everything from Sarah for an unrelated reason.
    expect(redactPage(page, 'contact:sarah', NOW).occurrences.length).toBeGreaterThan(0)
  })
})
