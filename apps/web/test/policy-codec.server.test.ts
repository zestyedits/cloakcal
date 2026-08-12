import { describe, expect, it } from 'vitest'
import { STANDARD_FIELDS } from '@cloakcal/policy'
import {
  MalformedRuleError,
  partitionRules,
  toDbFieldName,
  toPolicyFieldName,
  toVisibilityRule,
  type VisibilityRuleRow,
} from '../src/server/policy-codec'

/**
 * The database/engine vocabulary boundary.
 *
 * Two rules run through everything here:
 *
 *   An unknown FIELD is dropped. It resolves to "nothing grants this", which withholds.
 *   An unknown RULE throws. A rule exists to restrict something, so dropping one silently
 *   would make the calendar MORE visible than the user asked for — failing open, in the one
 *   place that must not.
 */

const row = (over: Partial<VisibilityRuleRow> = {}): VisibilityRuleRow => ({
  id: 'r1',
  scope: 'workspace',
  event_id: null,
  audience: 'individual',
  audience_ref: 'contact-1',
  group_priority: null,
  time_vis: 'exact',
  fields: { title: 'visible' },
  reveal_at: null,
  expires_at: null,
  ...over,
})

describe('field name translation', () => {
  it('maps the one name the two vocabularies spell differently', () => {
    // The whole reason this module exists. `audience.ts` used to cast here, so a field stored
    // as video_link looked up decision.fields['video_link'], found undefined, and was
    // withheld from every audience including the owner — with no error, and no way to grant
    // it. Invisible precisely because failing closed is the safe direction.
    expect(toPolicyFieldName('video_link')).toBe('videoLink')
    expect(toDbFieldName('videoLink')).toBe('video_link')
  })

  it('round-trips every standard field', () => {
    for (const name of STANDARD_FIELDS) {
      expect(toPolicyFieldName(toDbFieldName(name))).toBe(name)
    }
  })

  it('passes custom fields through untouched', () => {
    // Opaque to the engine and compared as strings, so translating them would break them.
    expect(toPolicyFieldName('custom:client-code')).toBe('custom:client-code')
    expect(toDbFieldName('custom:client-code')).toBe('custom:client-code')
  })

  it('accepts either spelling, deliberately', () => {
    // One function serves two callers with different input vocabularies:
    // `cloaked_fields.field_name` is a database allowlist and says `video_link`, while the
    // `fields` jsonb on a rule is written by our own client and says `videoLink`, because it
    // is a serialised Partial<Record<FieldName, ...>>. Nothing constrains the jsonb's keys,
    // so rejecting the camelCase spelling would silently drop the rule's own field grants —
    // the exact failure this module was written to stop, one layer up.
    expect(toPolicyFieldName('video_link')).toBe('videoLink')
    expect(toPolicyFieldName('videoLink')).toBe('videoLink')
  })

  it('refuses a name neither side knows', () => {
    expect(toPolicyFieldName('secret_sauce')).toBeNull()
    expect(toPolicyFieldName('')).toBeNull()
    expect(toPolicyFieldName('custom')).toBeNull()
  })

  it('covers every field name the database allows', () => {
    // Mirrors the cloaked_fields_valid_subject_field allowlist for events. If a migration
    // widens that constraint without adding a translation, this fails rather than the field
    // becoming permanently undisclosable.
    const allowedByTheDatabase = [
      'title',
      'location',
      'notes',
      'attendees',
      'video_link',
      'attachments',
    ]
    for (const name of allowedByTheDatabase) {
      expect(toPolicyFieldName(name)).not.toBeNull()
    }
  })
})

describe('decoding a rule', () => {
  it('renames the snake_case columns the engine does not use', () => {
    expect(
      toVisibilityRule(
        row({ audience: 'group', audience_ref: 'g1', group_priority: 10, time_vis: 'busy' }),
      ),
    ).toEqual({
      id: 'r1',
      scope: 'workspace',
      audience: 'group',
      audienceRef: 'g1',
      groupPriority: 10,
      timeVis: 'busy',
      fields: { title: 'visible' },
      revealAt: null,
      expiresAt: null,
    })
  })

  it('translates field keys inside the jsonb too', () => {
    const rule = toVisibilityRule(row({ fields: { video_link: 'visible', title: 'hidden' } }))
    expect(rule.fields).toEqual({ videoLink: 'visible', title: 'hidden' })
  })

  it('drops a field key it cannot name, rather than guessing', () => {
    // Dropping resolves to "no rule grants this", which withholds. Defaulting it either way
    // would make the failure mode depend on a guess.
    const rule = toVisibilityRule(row({ fields: { title: 'visible', mystery: 'visible' } }))
    expect(rule.fields).toEqual({ title: 'visible' })
  })

  it('drops a value that is not a visibility', () => {
    const rule = toVisibilityRule(row({ fields: { title: 'maybe', location: 'visible' } }))
    expect(rule.fields).toEqual({ location: 'visible' })
  })

  it.each([null, 'a string', 42, ['an', 'array']])('survives %s in the jsonb column', (raw) => {
    expect(toVisibilityRule(row({ fields: raw })).fields).toEqual({})
  })

  it('passes timestamps through as strings', () => {
    // Round-tripping through Date would drop sub-second precision and add a host-timezone
    // hop, and the engine compares them as instants anyway.
    const rule = toVisibilityRule(
      row({ reveal_at: '2026-05-19T13:00:00.123456+00:00', expires_at: '2026-06-01T00:00:00Z' }),
    )
    expect(rule.revealAt).toBe('2026-05-19T13:00:00.123456+00:00')
    expect(rule.expiresAt).toBe('2026-06-01T00:00:00Z')
  })
})

describe('a rule it cannot understand is an error, not a skip', () => {
  it.each([
    ['an unknown audience', { audience: 'everyone' }],
    ['an unknown scope', { scope: 'calendar' }],
    ['an unknown time visibility', { time_vis: 'sometimes' }],
    ['a group rule with no priority', { audience: 'group', audience_ref: 'g1' }],
  ])('throws on %s', (_label, over) => {
    expect(() => toVisibilityRule(row(over as Partial<VisibilityRuleRow>))).toThrow(
      MalformedRuleError,
    )
  })

  it('names the rule, so the row can be found', () => {
    expect(() => toVisibilityRule(row({ id: 'abc-123', audience: 'nobody' }))).toThrow(/abc-123/)
  })
})

describe('partitioning by scope', () => {
  it('separates workspace rules from event rules', () => {
    const { workspace, byEvent } = partitionRules([
      row({ id: 'w1' }),
      row({ id: 'e1', scope: 'event', event_id: 'ev-1' }),
      row({ id: 'e2', scope: 'event', event_id: 'ev-1' }),
      row({ id: 'e3', scope: 'event', event_id: 'ev-2' }),
    ])

    expect(workspace.map((r) => r.id)).toEqual(['w1'])
    expect(byEvent.get('ev-1')?.map((r) => r.id)).toEqual(['e1', 'e2'])
    expect(byEvent.get('ev-2')?.map((r) => r.id)).toEqual(['e3'])
  })

  it('returns an empty map when nothing is event-scoped', () => {
    const { workspace, byEvent } = partitionRules([row({ id: 'w1' }), row({ id: 'w2' })])
    expect(workspace).toHaveLength(2)
    expect(byEvent.size).toBe(0)
  })

  it('throws on an event rule with no event', () => {
    // The scope-pair CHECK makes this unreachable today. It is asserted anyway because
    // "unreachable" is a property of the current schema, and the alternative is a rule that
    // silently vanishes — which fails open.
    expect(() => partitionRules([row({ scope: 'event', event_id: null })])).toThrow(
      MalformedRuleError,
    )
  })
})
