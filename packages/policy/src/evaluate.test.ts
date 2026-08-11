import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { evaluate } from './evaluate.js'
import { explainDecision } from './view-as.js'
import { STANDARD_FIELDS, type EvaluateInput, type VisibilityRule } from './types.js'

/**
 * The five safety invariants from the plan, as executable properties.
 *
 * The vectors prove specific cases. These prove statements that must hold for EVERY input,
 * including ones nobody thought to write a vector for — which is where privacy bugs
 * actually live.
 */

const NOW = '2026-05-19T12:00:00Z'

const base = (over: Partial<EvaluateInput> = {}): EvaluateInput => ({
  event: { eventId: 'e1', workspaceId: 'ws1', lifecycle: 'active', rules: [] },
  viewer: { kind: 'individual', contactId: 'sarah' },
  workspace: { workspaceId: 'ws1', timeVis: 'hidden', fields: {}, rules: [] },
  now: NOW,
  policyVersion: 'v1',
  ...over,
})

const rule = (over: Partial<VisibilityRule> = {}): VisibilityRule => ({
  id: 'r1',
  scope: 'event',
  audience: 'individual',
  audienceRef: 'sarah',
  groupPriority: null,
  timeVis: 'exact',
  fields: { title: 'visible' },
  revealAt: null,
  expiresAt: null,
  ...over,
})

/* -------------------------------------------------------------------------- */

describe('invariant 1: deny by default', () => {
  it('hides everything when no rule applies', () => {
    const decision = evaluate(base({ viewer: { kind: 'unauthenticated' } }))
    expect(decision.eventVisible).toBe(false)
    expect(Object.values(decision.fields).every((v) => v === 'hidden')).toBe(true)
  })

  it('never throws, whatever it is handed', () => {
    // An engine that throws fails OPEN the moment a caller wraps it in try/catch and
    // carries on, so totality is a security property, not a style preference.
    fc.assert(
      fc.property(fc.anything(), (junk) => {
        expect(() => evaluate(junk as EvaluateInput)).not.toThrow()
      }),
      { numRuns: 300 },
    )
  })

  it('denies when handed junk', () => {
    fc.assert(
      fc.property(fc.anything(), (junk) => {
        const decision = evaluate(junk as EvaluateInput)
        expect(decision.eventVisible).toBe(false)
      }),
      { numRuns: 300 },
    )
  })

  it('denies an unknown policy version rather than guessing', () => {
    const decision = evaluate(base({ policyVersion: 'v2' as 'v1' }))
    expect(decision.eventVisible).toBe(false)
    expect(decision.trace.at(-1)?.step).toBe('deny-by-default')
  })

  it('treats a field absent from a rule as hidden', () => {
    const decision = evaluate(base({ event: { ...base().event, rules: [rule()] } }))
    expect(decision.fields['title']).toBe('visible')
    for (const field of STANDARD_FIELDS.filter((f) => f !== 'title')) {
      expect(decision.fields[field]).toBe('hidden')
    }
  })
})

describe('invariant 2: precedence holds', () => {
  it('never lets a group rule override an individual rule', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('exact', 'busy', 'hidden' as const),
        fc.constantFrom('exact', 'busy', 'hidden' as const),
        fc.integer({ min: 0, max: 100 }),
        (individualTime, groupTime, priority) => {
          const withGroup = evaluate(
            base({
              viewer: { kind: 'individual', contactId: 'sarah', groupIds: ['g'] },
              event: {
                ...base().event,
                rules: [
                  rule({ id: 'ind', timeVis: individualTime as 'exact' }),
                  rule({
                    id: 'grp',
                    audience: 'group',
                    audienceRef: 'g',
                    groupPriority: priority,
                    timeVis: groupTime as 'exact',
                    fields: { location: 'visible' },
                  }),
                ],
              },
            }),
          )

          const individualOnly = evaluate(
            base({
              viewer: { kind: 'individual', contactId: 'sarah', groupIds: ['g'] },
              event: { ...base().event, rules: [rule({ id: 'ind', timeVis: individualTime as 'exact' })] },
            }),
          )

          // Adding a group rule must not change the outcome at all.
          expect(withGroup.time).toBe(individualOnly.time)
          expect(withGroup.fields).toEqual(individualOnly.fields)
        },
      ),
      { numRuns: 200 },
    )
  })

  it('is independent of rule array order', () => {
    fc.assert(
      fc.property(fc.shuffledSubarray([0, 1, 2], { minLength: 3 }), (order) => {
        const rules = [
          rule({ id: 'a', audience: 'group', audienceRef: 'g1', groupPriority: 3, fields: {} }),
          rule({ id: 'b', audience: 'group', audienceRef: 'g2', groupPriority: 1, fields: { title: 'visible' } }),
          rule({ id: 'c', audience: 'public', audienceRef: null, timeVis: 'busy', fields: {} }),
        ]
        const shuffled = order.map((i) => rules[i]!)

        const decision = evaluate(
          base({
            viewer: { kind: 'individual', contactId: 'x', groupIds: ['g1', 'g2'] },
            event: { ...base().event, rules: shuffled },
          }),
        )
        // g2 has the lower priority number, so it wins regardless of ordering.
        expect(decision.fields['title']).toBe('visible')
      }),
      { numRuns: 60 },
    )
  })
})

describe('invariant 3: redaction soundness', () => {
  it('never marks a field visible that no applicable rule made visible', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...STANDARD_FIELDS), { maxLength: 6 }),
        (granted) => {
          const fields = Object.fromEntries(granted.map((f) => [f, 'visible' as const]))
          const decision = evaluate(
            base({ event: { ...base().event, rules: [rule({ fields })] } }),
          )

          for (const field of STANDARD_FIELDS) {
            if (!granted.includes(field)) expect(decision.fields[field]).toBe('hidden')
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  it('discloses nothing at all when time is hidden', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...STANDARD_FIELDS)), (granted) => {
        const fields = Object.fromEntries(granted.map((f) => [f, 'visible' as const]))
        const decision = evaluate(
          base({ event: { ...base().event, rules: [rule({ timeVis: 'hidden', fields })] } }),
        )
        expect(decision.eventVisible).toBe(false)
        expect(Object.values(decision.fields).every((v) => v === 'hidden')).toBe(true)
      }),
      { numRuns: 100 },
    )
  })

  it('discloses no field when time is busy, however permissive the rule', () => {
    // A rule saying "busy, but show the title" is incoherent; resolving it in the engine
    // means every consumer agrees rather than each deciding for itself.
    const decision = evaluate(
      base({
        event: {
          ...base().event,
          rules: [rule({ timeVis: 'busy', fields: { title: 'visible', location: 'visible' } })],
        },
      }),
    )
    expect(decision.time).toBe('busy')
    expect(Object.values(decision.fields).every((v) => v === 'hidden')).toBe(true)
  })
})

describe('invariant 4: time rules are monotonic', () => {
  it('never reveals before revealAt', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000_000 }), (msBefore) => {
        const revealAt = '2026-06-01T00:00:00Z'
        const now = new Date(Date.parse(revealAt) - msBefore).toISOString()
        const decision = evaluate(
          base({ now, event: { ...base().event, rules: [rule({ revealAt })] } }),
        )
        expect(decision.eventVisible).toBe(false)
      }),
      { numRuns: 200 },
    )
  })

  it('reveals at and after revealAt', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), (msAfter) => {
        const revealAt = '2026-06-01T00:00:00Z'
        const now = new Date(Date.parse(revealAt) + msAfter).toISOString()
        const decision = evaluate(
          base({ now, event: { ...base().event, rules: [rule({ revealAt })] } }),
        )
        expect(decision.eventVisible).toBe(true)
      }),
      { numRuns: 200 },
    )
  })

  it('stays hidden at and after expiresAt, forever', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000_000 }), (msAfter) => {
        const expiresAt = '2026-06-01T00:00:00Z'
        const now = new Date(Date.parse(expiresAt) + msAfter).toISOString()
        const decision = evaluate(
          base({ now, event: { ...base().event, rules: [rule({ expiresAt })] } }),
        )
        // Falls through to the workspace default, which is 'hidden' here.
        expect(decision.eventVisible).toBe(false)
      }),
      { numRuns: 200 },
    )
  })

  it('reverts to the workspace default on expiry rather than denying outright', () => {
    const decision = evaluate(
      base({
        now: '2026-07-01T00:00:00Z',
        workspace: { workspaceId: 'ws1', timeVis: 'busy', fields: {}, rules: [] },
        event: { ...base().event, rules: [rule({ expiresAt: '2026-06-01T00:00:00Z' })] },
      }),
    )
    expect(decision.time).toBe('busy')
    expect(decision.trace.some((t) => t.step === 'rule-expired')).toBe(true)
  })
})

describe('invariant 5: determinism', () => {
  it('returns the same decision for the same input, every time', () => {
    const input = base({
      viewer: { kind: 'individual', contactId: 'sarah', groupIds: ['a', 'b'] },
      event: {
        ...base().event,
        rules: [
          rule({ id: 'x', audience: 'group', audienceRef: 'a', groupPriority: 1 }),
          rule({ id: 'y', audience: 'group', audienceRef: 'b', groupPriority: 1 }),
        ],
      },
    })

    const first = JSON.stringify(evaluate(input))
    for (let i = 0; i < 25; i += 1) expect(JSON.stringify(evaluate(input))).toBe(first)
  })

  it('does not mutate its input', () => {
    const input = base({ event: { ...base().event, rules: [rule()] } })
    const before = JSON.stringify(input)
    evaluate(input)
    expect(JSON.stringify(input)).toBe(before)
  })

  it('returns a frozen decision, so a caller cannot widen it after the fact', () => {
    const decision = evaluate(base({ event: { ...base().event, rules: [rule()] } }))
    expect(Object.isFrozen(decision.fields)).toBe(true)
  })
})

describe('the trace explains the decision', () => {
  it('always records at least one step', () => {
    fc.assert(
      fc.property(fc.constantFrom('owner', 'individual', 'public', 'unauthenticated' as const), (kind) => {
        const decision = evaluate(base({ viewer: { kind: kind as 'owner' } }))
        expect(decision.trace.length).toBeGreaterThan(0)
      }),
      { numRuns: 40 },
    )
  })

  it('names the winning rule', () => {
    const decision = evaluate(base({ event: { ...base().event, rules: [rule({ id: 'winner' })] } }))
    expect(decision.trace.at(-1)?.ruleId).toBe('winner')
  })

  it('produces a plain-language consequence from the recipient point of view', () => {
    const decision = evaluate(base({ event: { ...base().event, rules: [rule()] } }))
    const text = explainDecision(decision)
    expect(text).toMatch(/^They will see/)
    expect(text).toContain('the title')
    expect(text).toMatch(/\.$/)
  })

  it('explains a denial without implying an event exists', () => {
    const text = explainDecision(evaluate(base({ viewer: { kind: 'unauthenticated' } })))
    expect(text).toBe('They will not see this event at all.')
  })

  it('explains a busy block', () => {
    const decision = evaluate(
      base({ event: { ...base().event, rules: [rule({ timeVis: 'busy' })] } }),
    )
    expect(explainDecision(decision)).toBe('They will see that you are busy, and nothing else.')
  })
})
