import { describe, expect, it } from 'vitest'
import { redactForRecipient } from '../src/index.js'
import { VECTORS, visibleFieldsOf } from './vectors.js'

/**
 * Server-side redaction, driven by the shared vectors.
 *
 * Asserts both halves of a decision: the Decision object itself, and the payload a
 * recipient actually receives. Checking only the Decision would let a redaction bug ship
 * a field the engine said was hidden.
 */

describe('server redaction', () => {
  it.each(VECTORS.map((v) => [v.name, v] as const))('%s', (_name, vector) => {
    const { decision, event } = redactForRecipient(vector.input, vector.payload)

    expect(decision.eventVisible).toBe(vector.expect.eventVisible)
    expect(decision.time).toBe(vector.expect.time)
    expect(visibleFieldsOf(decision)).toEqual([...vector.expect.visibleFields].sort())

    if (!vector.expect.eventVisible) {
      expect(event).toBeNull()
      return
    }

    expect(event).not.toBeNull()

    // The DECISION covers every field the engine knows about; the PAYLOAD can only carry
    // fields this event actually has. Asserting the intersection keeps both meaningful —
    // conflating them would hide a decision that silently omits a field rather than
    // hiding it.
    const carried = vector.payload.fields.map((f) => String(f.fieldName))
    const expected = [...vector.expect.visibleFields].filter((f) => carried.includes(f)).sort()
    expect(event!.fields.map((f) => String(f.fieldName)).sort()).toEqual(expected)
  })
})

describe('the redacted payload discloses nothing beyond the decision', () => {
  it.each(VECTORS.map((v) => [v.name, v] as const))(
    'carries no hidden field in %s',
    (_name, vector) => {
      const { decision, event } = redactForRecipient(vector.input, vector.payload)
      if (event === null) return

      const hidden = Object.entries(decision.fields)
        .filter(([, v]) => v === 'hidden')
        .map(([k]) => k)

      // Absent, not blanked: a recipient must not be able to infer that a hidden field
      // exists from an empty entry in the response.
      const serialised = JSON.stringify(event)
      for (const field of hidden) {
        expect(event.fields.some((f) => f.fieldName === field)).toBe(false)
        expect(serialised).not.toContain(`"fieldName":"${field}"`)
      }
    },
  )

  it('withholds the calendar id from a busy block', () => {
    const busy = VECTORS.find((v) => v.name === 'busy-only-hides-title')!
    const { event } = redactForRecipient(busy.input, busy.payload)
    // Grouping is a disclosure: two busy blocks sharing a calendar id would reveal that
    // they belong together.
    expect(event?.calendarId).toBeUndefined()
    expect(event?.timezone).toBeUndefined()
  })

  it('still discloses when a busy block starts and ends', () => {
    const busy = VECTORS.find((v) => v.name === 'busy-only-hides-title')!
    const { event } = redactForRecipient(busy.input, busy.payload)
    expect(event?.start).toBe(busy.payload.start)
    expect(event?.end).toBe(busy.payload.end)
  })
})

describe('the vector set is worth running', () => {
  it('covers every decision outcome', () => {
    const outcomes = new Set(VECTORS.map((v) => `${v.expect.eventVisible}:${v.expect.time}`))
    expect(outcomes).toContain('true:exact')
    expect(outcomes).toContain('true:busy')
    expect(outcomes).toContain('false:hidden')
  })

  it('has no duplicate names', () => {
    const names = VECTORS.map((v) => v.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('is large enough to be meaningful', () => {
    expect(VECTORS.length).toBeGreaterThanOrEqual(20)
  })
})
