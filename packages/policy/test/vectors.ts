import raw from '../vectors/v1/vectors.json' with { type: 'json' }
import type { EvaluateInput, EventPayload, FieldName, VisibilityRule } from '../src/index.js'

/**
 * Shared vector loader.
 *
 * Both the server suite and the client View As suite import THIS module, so they are
 * provably running the same cases. Duplicating the vectors into either suite would let
 * them drift, and the whole point of D2 is that they cannot.
 */

export interface Vector {
  readonly name: string
  readonly input: EvaluateInput
  readonly payload: EventPayload
  readonly expect: {
    readonly eventVisible: boolean
    readonly time: string
    readonly visibleFields: readonly string[]
  }
}

const DEFAULT_NOW = '2026-05-19T08:00:00-04:00'

export const PAYLOAD = raw.payload as unknown as EventPayload

export const VECTORS: readonly Vector[] = raw.vectors.map((v) => {
  const spec = v as unknown as {
    name: string
    now?: string
    lifecycle?: 'active' | 'trashed' | 'purged'
    workspaceTimeVis?: 'exact' | 'busy' | 'hidden'
    customFields?: `custom:${string}`[]
    viewer: EvaluateInput['viewer']
    eventRules: VisibilityRule[]
    workspaceRules: VisibilityRule[]
    expect: Vector['expect']
  }

  const payload: EventPayload =
    spec.customFields === undefined
      ? PAYLOAD
      : {
          ...PAYLOAD,
          fields: [
            ...PAYLOAD.fields,
            ...spec.customFields.map((fieldName) => ({
              fieldName: fieldName as FieldName,
              ciphertext: '99',
              nonce: '88',
              alg: 'aes-256-gcm-v1',
              keyVersion: 1,
            })),
          ],
        }

  return {
    name: spec.name,
    payload,
    expect: spec.expect,
    input: {
      event: {
        eventId: PAYLOAD.eventId,
        workspaceId: 'ws1',
        lifecycle: spec.lifecycle ?? 'active',
        rules: spec.eventRules,
      },
      viewer: spec.viewer,
      workspace: {
        workspaceId: 'ws1',
        timeVis: spec.workspaceTimeVis ?? 'hidden',
        fields: {},
        rules: spec.workspaceRules,
      },
      now: spec.now ?? DEFAULT_NOW,
      policyVersion: 'v1',
      customFields: spec.customFields,
    },
  }
})

/** Every field name a vector could disclose, for exhaustive checking. */
export const visibleFieldsOf = (decision: { fields: Record<string, string> }): string[] =>
  Object.entries(decision.fields)
    .filter(([, v]) => v === 'visible')
    .map(([k]) => k)
    .sort()
