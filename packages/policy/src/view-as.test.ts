import { describe, expect, it } from 'vitest'
import { decisionToLevel } from './view-as.js'
import { STANDARD_FIELDS, type Decision, type FieldName, type FieldVisibility } from './types.js'

/**
 * decisionToLevel is the ONLY mapping from a Decision onto the four-step scale the UI
 * renders. These tests pin its edges, because a chip that says "Busy" over an event that
 * actually discloses its exact time is the product lying about its own core promise.
 */

const fields = (
  overrides: Partial<Record<FieldName, FieldVisibility>> = {},
): Record<FieldName, FieldVisibility> =>
  ({
    ...Object.fromEntries(STANDARD_FIELDS.map((f) => [f, 'hidden'])),
    ...overrides,
  }) as Record<FieldName, FieldVisibility>

const decision = (partial: Partial<Decision>): Decision => ({
  eventVisible: true,
  time: 'exact',
  fields: fields(),
  trace: [],
  ...partial,
})

describe('decisionToLevel', () => {
  it('maps an invisible event to hidden regardless of anything else', () => {
    expect(
      decisionToLevel(decision({ eventVisible: false, fields: fields({ title: 'visible' }) })),
    ).toBe('hidden')
  })

  it('maps hidden time to hidden even if the engine ever emitted it with eventVisible', () => {
    expect(decisionToLevel(decision({ time: 'hidden' }))).toBe('hidden')
  })

  it('maps busy time to busy', () => {
    expect(decisionToLevel(decision({ time: 'busy' }))).toBe('busy')
  })

  it('maps exact time with every field visible to full', () => {
    const everything = Object.fromEntries(
      STANDARD_FIELDS.map((f) => [f, 'visible']),
    ) as Record<FieldName, FieldVisibility>
    expect(decisionToLevel(decision({ fields: everything }))).toBe('full')
  })

  it('maps exact time with a mix of fields to limited', () => {
    expect(decisionToLevel(decision({ fields: fields({ title: 'visible' }) }))).toBe('limited')
  })

  it('maps exact time with NO visible fields to limited, not busy', () => {
    // The degenerate case that tempts a busy label: no fields are shown, but the exact
    // span is — which is strictly more disclosure than a busy block.
    expect(decisionToLevel(decision({ fields: fields() }))).toBe('limited')
  })
})
