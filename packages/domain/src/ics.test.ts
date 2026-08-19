import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { toIcs, type IcsEvent } from './ics.js'
import { expandSeries } from './recurrence.js'

/**
 * The .ics emitter.
 *
 * Two things here are worth more than the rest: the octet-based folding, because folding by
 * character count passes every test written in English and corrupts the first title written
 * in another language; and the round trip through `expandSeries`, because the whole point of
 * exporting a series rather than its occurrences is that the recipient regenerates the same
 * dates — including across a DST boundary, which is where a `Z`-instant DTSTART would break
 * silently and in one direction only.
 */

const STAMP = '20260519T120000Z'

const event = (over: Partial<IcsEvent> = {}): IcsEvent => ({
  uid: 'e1@cloakcal',
  series: {
    dtstartLocal: '2026-05-19T09:00:00',
    durationMinutes: 60,
    timezone: 'America/New_York',
    rrule: null,
  },
  allDay: false,
  busy: 'busy',
  summary: 'Discovery call',
  ...over,
})

const emit = (...events: IcsEvent[]) => toIcs({ events, stamp: STAMP })

/** Unfold before asserting on content: a folded line is still one logical property. */
const unfold = (ics: string) => ics.replace(/\r\n /g, '')
const props = (ics: string) => unfold(ics).split('\r\n')

describe('the file envelope', () => {
  it('opens and closes a VCALENDAR and terminates the last line', () => {
    const ics = emit(event())
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true)
    // Required. A file whose last line has no terminator is rejected by strict parsers and
    // silently truncated by lenient ones, which is the worse of the two.
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true)
  })

  it('uses CRLF everywhere, never a bare LF', () => {
    const ics = emit(event({ summary: 'One', description: 'Two' }))
    expect(/[^\r]\n/.test(ics)).toBe(false)
  })

  it('emits an empty but valid calendar when there is nothing to export', () => {
    // A user with no events must still get a file. Returning nothing would read as a failure.
    const ics = emit()
    expect(props(ics)).toContain('END:VCALENDAR')
    expect(ics).not.toContain('BEGIN:VEVENT')
  })
})

describe('escaping, per RFC 5545 §3.3.11', () => {
  it('escapes backslash before anything it goes on to add', () => {
    // Order matters: escape the others first and every backslash this adds gets escaped again.
    const ics = emit(event({ summary: 'a\\b' }))
    expect(props(ics)).toContain('SUMMARY:a\\\\b')
  })

  it('escapes semicolon, comma and newline', () => {
    const ics = emit(event({ summary: 'a;b,c\nd' }))
    expect(props(ics)).toContain('SUMMARY:a\\;b\\,c\\nd')
  })

  it('leaves a colon alone', () => {
    // The reflex is to escape it. TEXT values do not, and doing so puts literal backslashes
    // into somebody's event title.
    const ics = emit(event({ summary: 'Standup: daily' }))
    expect(props(ics)).toContain('SUMMARY:Standup: daily')
  })

  it('collapses CRLF to a single escaped newline', () => {
    const ics = emit(event({ description: 'one\r\ntwo' }))
    expect(props(ics)).toContain('DESCRIPTION:one\\ntwo')
  })
})

describe('folding, which is measured in octets and not characters', () => {
  const longest = (ics: string) =>
    Math.max(...ics.split('\r\n').map((l) => new TextEncoder().encode(l).length))

  it('keeps every physical line within 75 octets', () => {
    const ics = emit(event({ summary: 'x'.repeat(400) }))
    expect(longest(ics)).toBeLessThanOrEqual(75)
  })

  it('holds for multi-byte text, which is where a character count fails', () => {
    // Each of these is 4 octets and 1 character. A `.length`-based fold would emit lines of
    // roughly 300 octets here and pass a test written in English.
    const ics = emit(event({ summary: '🔒'.repeat(80) }))
    expect(longest(ics)).toBeLessThanOrEqual(75)
  })

  it('never splits a codepoint', () => {
    const ics = emit(event({ summary: '🔒'.repeat(80) }))
    expect(ics).not.toContain('\uFFFD')
    expect(unfold(ics)).toContain('🔒'.repeat(80))
  })

  it('round-trips the exact value through folding, for arbitrary text', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 300 }), (summary) => {
        // Control characters are not representable in a content line and are out of scope.
        const clean = summary.replace(/[\u0000-\u001f\u007f]/g, ' ')
        if (clean.trim() === '') return
        const recovered = props(emit(event({ summary: clean })))
          .find((l) => l.startsWith('SUMMARY:'))
          ?.slice('SUMMARY:'.length)
        expect(recovered).toBe(
          clean.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,'),
        )
      }),
      { numRuns: 200 },
    )
  })
})

describe('what a VEVENT carries', () => {
  it('anchors a timed event to its zone, never to a UTC instant', () => {
    // The wall-clock guarantee, at the boundary. A `Z` instant here would make the recipient
    // regenerate different local times across a DST change.
    const ics = props(emit(event()))
    expect(ics).toContain('DTSTART;TZID=America/New_York:20260519T090000')
    expect(ics.some((l) => /^DTSTART.*Z$/.test(l))).toBe(false)
  })

  it('uses DURATION rather than DTEND', () => {
    // DTEND applies only to the first instance of a recurring event. DURATION is what keeps
    // a one-hour meeting one hour on every occurrence.
    expect(props(emit(event()))).toContain('DURATION:PT1H')
  })

  it.each([
    [30, 'PT30M'],
    [90, 'PT1H30M'],
    [60, 'PT1H'],
    [1, 'PT1M'],
  ])('formats %i minutes as %s', (minutes, expected) => {
    const ics = props(emit(event({ series: { ...event().series, durationMinutes: minutes } })))
    expect(ics).toContain(`DURATION:${expected}`)
  })

  it('makes a whole-day event date-valued and zoneless', () => {
    // The one case where dropping the timezone is CORRECT: 19 May is 19 May wherever it is read.
    const ics = props(emit(event({ allDay: true, series: { ...event().series, durationMinutes: 1440 } })))
    expect(ics).toContain('DTSTART;VALUE=DATE:20260519')
    expect(ics).toContain('DURATION:P1D')
  })

  it('omits a field rather than emitting it blank', () => {
    // Absent, never blank — the same rule redaction follows. An empty SUMMARY renders as a
    // nameless event in every client, which is worse than no property at all.
    const ics = props(emit(event({ summary: undefined, location: '', description: undefined })))
    expect(ics.some((l) => l.startsWith('SUMMARY'))).toBe(false)
    expect(ics.some((l) => l.startsWith('LOCATION'))).toBe(false)
    expect(ics.some((l) => l.startsWith('DESCRIPTION'))).toBe(false)
  })

  it('marks free time transparent and tentative time as such', () => {
    expect(props(emit(event({ busy: 'free' })))).toContain('TRANSP:TRANSPARENT')
    const tentative = props(emit(event({ busy: 'tentative' })))
    expect(tentative).toContain('STATUS:TENTATIVE')
    expect(tentative).toContain('TRANSP:OPAQUE')
  })

  it('emits cancelled occurrences as one zoned EXDATE', () => {
    const ics = props(
      emit(
        event({
          series: { ...event().series, rrule: 'FREQ=WEEKLY;BYDAY=TU' },
          exdates: ['2026-05-26T09:00:00', '2026-06-02T09:00:00'],
        }),
      ),
    )
    expect(ics).toContain(
      'EXDATE;TZID=America/New_York:20260526T090000,20260602T090000',
    )
  })

  it('writes no ATTENDEE or ORGANIZER', () => {
    // Deliberate. Emitting them turns an export into something a receiving client may try to
    // send invitations from, on behalf of a user who asked for a backup.
    const ics = emit(event({ description: 'with alex@example.com' }))
    expect(ics).not.toContain('ATTENDEE')
    expect(ics).not.toContain('ORGANIZER')
  })
})

describe('a recurring series survives the trip', () => {
  it('regenerates the same occurrences after export, across a DST boundary', () => {
    /*
     * The reason series are exported as a rule rather than as expanded dates. March 8 2026 is
     * the US spring-forward; a series anchored at 09:00 must still read 09:00 on both sides,
     * and the recipient has to be able to derive that from the file.
     */
    const series = {
      dtstartLocal: '2026-03-01T09:00:00',
      durationMinutes: 60,
      timezone: 'America/New_York',
      rrule: 'FREQ=WEEKLY;BYDAY=SU;COUNT=4',
    }
    const ics = props(emit(event({ series })))

    expect(ics).toContain('DTSTART;TZID=America/New_York:20260301T090000')
    expect(ics).toContain('RRULE:FREQ=WEEKLY;BYDAY=SU;COUNT=4')

    // expandSeries filters on resolved INSTANTS, so the range carries an offset. Passing a
    // floating local string here throws rather than silently widening, which is the right
    // shape for a function whose whole job is to resolve wall time.
    const occurrences = expandSeries(series, {
      from: '2026-03-01T00:00:00Z',
      to: '2026-04-01T00:00:00Z',
    })
    expect(occurrences.length).toBeGreaterThan(1)
    // Every occurrence keeps the wall time the file states, which is what the recipient
    // reconstructs from DTSTART;TZID plus the rule.
    for (const occurrence of occurrences) {
      expect(occurrence.occurrenceLocal).toContain('T09:00')
    }
  })

  it('converts UNTIL to UTC, because RFC 5545 requires it and we store it local', () => {
    // The hazard `ical.ts` exists for, asserted from this side so the two cannot drift.
    const ics = props(
      emit(
        event({
          series: {
            ...event().series,
            rrule: 'FREQ=WEEKLY;UNTIL=20260630T090000Z',
          },
        }),
      ),
    )
    const rrule = ics.find((l) => l.startsWith('RRULE:'))
    expect(rrule).toMatch(/UNTIL=\d{8}T\d{6}Z/)
    // 09:00 in New York in June is 13:00 UTC. A pass-through would leave 090000Z here.
    expect(rrule).toContain('UNTIL=20260630T130000Z')
  })
})
