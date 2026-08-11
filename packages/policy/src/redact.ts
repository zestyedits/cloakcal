import type { Decision, FieldName } from './types.js'

/**
 * Payload redaction.
 *
 * Applies a Decision to an event payload. Both the server and View As route through this
 * one function, which is what makes their agreement a fact rather than a hope.
 *
 * The engine never sees content: `fields` carry ciphertext, and redaction removes whole
 * entries rather than blanking values. A redacted payload does not contain an empty string
 * where a title was — it contains no title entry at all, so a recipient cannot infer that
 * a hidden field exists from the shape of what they received.
 */

export interface CiphertextField {
  readonly fieldName: FieldName
  readonly ciphertext: string
  readonly nonce: string
  readonly alg: string
  readonly keyVersion: number
}

/** The full Tier A record, before redaction. */
export interface EventPayload {
  readonly eventId: string
  readonly calendarId: string
  readonly start: string
  readonly end: string
  readonly timezone: string
  readonly allDay: boolean
  readonly busy: 'busy' | 'free' | 'tentative'
  readonly fields: readonly CiphertextField[]
}

/** What a recipient actually receives. Fields are absent, never blanked. */
export interface RedactedEvent {
  readonly eventId: string
  readonly time: 'exact' | 'busy'
  readonly start: string
  readonly end: string
  readonly timezone?: string
  readonly allDay?: boolean
  readonly busy?: 'busy' | 'free' | 'tentative'
  readonly calendarId?: string
  readonly fields: readonly CiphertextField[]
}

/** Returns null when the event must not be disclosed at all. */
export function redact(payload: EventPayload, decision: Decision): RedactedEvent | null {
  if (!decision.eventVisible || decision.time === 'hidden') return null

  if (decision.time === 'busy') {
    // A busy block reveals when, and nothing else. calendarId is withheld too: it is an
    // opaque id, but it groups events, and grouping is itself a disclosure — a recipient
    // could otherwise tell that two busy blocks belong to the same calendar.
    return {
      eventId: payload.eventId,
      time: 'busy',
      start: payload.start,
      end: payload.end,
      fields: Object.freeze([]),
    }
  }

  return {
    eventId: payload.eventId,
    time: 'exact',
    start: payload.start,
    end: payload.end,
    timezone: payload.timezone,
    allDay: payload.allDay,
    busy: payload.busy,
    calendarId: payload.calendarId,
    fields: Object.freeze(
      payload.fields.filter((field) => decision.fields[field.fieldName] === 'visible'),
    ),
  }
}
