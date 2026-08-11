import { describe, expect, it } from 'vitest'
import { previewAs, redactForRecipient } from '../src/index.js'
import { VECTORS, visibleFieldsOf } from './vectors.js'

/**
 * View As, driven by the SAME vectors as the server suite.
 *
 * The contract test at the bottom is the mechanism behind plan D2: View As is a trust
 * feature, so it must be provably identical to what a real recipient receives — not
 * similar, not approximately right, identical.
 */

describe('View As', () => {
  it.each(VECTORS.map((v) => [v.name, v] as const))('%s', (_name, vector) => {
    const { decision, event } = previewAs(vector.input, vector.payload)

    expect(decision.eventVisible).toBe(vector.expect.eventVisible)
    expect(decision.time).toBe(vector.expect.time)
    expect(visibleFieldsOf(decision)).toEqual([...vector.expect.visibleFields].sort())

    if (!vector.expect.eventVisible) expect(event).toBeNull()
  })
})

describe('CONTRACT: View As equals the real recipient response', () => {
  it.each(VECTORS.map((v) => [v.name, v] as const))(
    'produces byte-identical output for %s',
    (_name, vector) => {
      const server = redactForRecipient(vector.input, vector.payload)
      const client = previewAs(vector.input, vector.payload)

      // Deep equality on BOTH the decision and the payload. If a future change gives
      // either path a cache, a fast path, or a shortcut, this fails on the next run.
      expect(JSON.stringify(client.event)).toBe(JSON.stringify(server.event))
      expect(JSON.stringify(client.decision.fields)).toBe(JSON.stringify(server.decision.fields))
      expect(client.decision.time).toBe(server.decision.time)
      expect(client.decision.eventVisible).toBe(server.decision.eventVisible)
    },
  )

  it('agrees on the trace, so the explanation shown matches the reason applied', () => {
    for (const vector of VECTORS) {
      const server = redactForRecipient(vector.input, vector.payload)
      const client = previewAs(vector.input, vector.payload)
      expect(client.decision.trace).toEqual(server.decision.trace)
    }
  })
})
