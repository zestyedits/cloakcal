import {
  POLICY_VERSION,
  STANDARD_FIELDS,
  type Decision,
  type EvaluateInput,
  type FieldName,
  type FieldVisibility,
  type RuleTrace,
  type TimeVisibility,
  type ViewerIdentity,
  type VisibilityRule,
} from './types.js'

/**
 * The visibility engine.
 *
 * Pure, total and deterministic. No I/O, no ambient clock, never throws — a malformed
 * input yields a fully-hidden decision rather than an exception, because an engine that
 * throws in an unexpected corner is an engine that fails OPEN somewhere upstream when a
 * caller wraps it in a try/catch and carries on.
 *
 * Precedence, exactly as specified:
 *
 *   explicit individual rule  >  applicable group rule  >  event default  >  workspace default
 *
 * Audience specificity dominates scope: a workspace-scoped INDIVIDUAL rule beats an
 * event-scoped GROUP rule, because the spec orders by audience and says nothing about
 * scope outranking it. Scope only breaks ties within the same audience class, where the
 * more specific (event) rule wins.
 */

/** Lower is more specific. */
const AUDIENCE_RANK: Record<VisibilityRule['audience'], number> = {
  owner: 0,
  individual: 1,
  group: 2,
  public: 3,
}

const SCOPE_RANK: Record<VisibilityRule['scope'], number> = { event: 0, workspace: 1 }

/** Higher is more restrictive. Used only for the D8 tiebreak. */
const TIME_RESTRICTION: Record<TimeVisibility, number> = { exact: 0, busy: 1, hidden: 2 }

const ALL_HIDDEN = (fields: readonly FieldName[]): Record<FieldName, FieldVisibility> =>
  Object.fromEntries(fields.map((f) => [f, 'hidden'])) as Record<FieldName, FieldVisibility>

const denied = (fields: readonly FieldName[], trace: RuleTrace[]): Decision => ({
  eventVisible: false,
  time: 'hidden',
  fields: Object.freeze(ALL_HIDDEN(fields)),
  trace: Object.freeze([...trace]),
})

/** A rule is inert outside its time window. Boundaries: revealAt inclusive, expiresAt exclusive. */
function windowState(
  rule: VisibilityRule,
  now: number,
): 'active' | 'not-yet-revealed' | 'expired' {
  if (rule.revealAt !== null) {
    const revealAt = Date.parse(rule.revealAt)
    if (Number.isFinite(revealAt) && now < revealAt) return 'not-yet-revealed'
  }
  if (rule.expiresAt !== null) {
    const expiresAt = Date.parse(rule.expiresAt)
    if (Number.isFinite(expiresAt) && now >= expiresAt) return 'expired'
  }
  return 'active'
}

function appliesTo(rule: VisibilityRule, viewer: ViewerIdentity): boolean {
  switch (rule.audience) {
    case 'individual':
      return viewer.kind === 'individual' && rule.audienceRef === viewer.contactId
    case 'group':
      return (
        rule.audienceRef !== null &&
        (viewer.groupIds ?? []).includes(rule.audienceRef) &&
        rule.groupPriority !== null
      )
    case 'public':
      // A public rule reaches everyone, including signed-in viewers with no better match.
      return true
    case 'owner':
      return viewer.kind === 'owner'
  }
}

/** How restrictive a rule is overall. Higher wins the D8 "most restrictive" tiebreak. */
function restrictiveness(rule: VisibilityRule, fields: readonly FieldName[]): number {
  const hidden = fields.filter((f) => rule.fields[f] !== 'visible').length
  return TIME_RESTRICTION[rule.timeVis] * 1000 + hidden
}

/**
 * D8: when several group rules apply, order by user-defined priority ascending, then most
 * restrictive, then group id lexicographically. Fully deterministic — no dependence on
 * array order, database ordering, or set iteration.
 */
function compareGroupRules(a: VisibilityRule, b: VisibilityRule, fields: readonly FieldName[]): number {
  const priority = (a.groupPriority ?? Number.MAX_SAFE_INTEGER) - (b.groupPriority ?? Number.MAX_SAFE_INTEGER)
  if (priority !== 0) return priority

  const restriction = restrictiveness(b, fields) - restrictiveness(a, fields)
  if (restriction !== 0) return restriction

  return (a.audienceRef ?? '').localeCompare(b.audienceRef ?? '')
}

function compareRules(a: VisibilityRule, b: VisibilityRule, fields: readonly FieldName[]): number {
  const audience = AUDIENCE_RANK[a.audience] - AUDIENCE_RANK[b.audience]
  if (audience !== 0) return audience

  if (a.audience === 'group') {
    const grouped = compareGroupRules(a, b, fields)
    if (grouped !== 0) return grouped
  }

  const scope = SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope]
  if (scope !== 0) return scope

  // Final tiebreak so the result cannot depend on input ordering.
  return a.id.localeCompare(b.id)
}

const TRACE_STEP: Record<VisibilityRule['audience'], RuleTrace['step']> = {
  owner: 'owner',
  individual: 'individual-rule',
  group: 'group-rule',
  public: 'event-default',
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isCustomField = (value: unknown): value is `custom:${string}` =>
  typeof value === 'string' && value.startsWith('custom:')

/** Only rules with a shape the engine understands. Anything else is ignored, not trusted. */
const usableRules = (value: unknown): VisibilityRule[] =>
  Array.isArray(value)
    ? value.filter(
        (rule): rule is VisibilityRule =>
          isRecord(rule) &&
          typeof rule.id === 'string' &&
          (rule.scope === 'event' || rule.scope === 'workspace') &&
          typeof rule.audience === 'string' &&
          rule.audience in AUDIENCE_RANK &&
          typeof rule.timeVis === 'string' &&
          rule.timeVis in TIME_RESTRICTION &&
          isRecord(rule.fields),
      )
    : []

export function evaluate(input: EvaluateInput): Decision {
  // Totality is a SECURITY property, not a style preference. An engine that throws on an
  // unexpected shape fails OPEN the moment a caller wraps it in try/catch and carries on,
  // so every dereference below is guarded and every malformed input denies.
  const raw: Record<string, unknown> = isRecord(input) ? input : {}

  const customFields = Array.isArray(raw['customFields'])
    ? (raw['customFields'] as unknown[]).filter(isCustomField)
    : []
  const fields: FieldName[] = [...STANDARD_FIELDS, ...customFields]
  const trace: RuleTrace[] = []

  const event = isRecord(raw['event']) ? raw['event'] : null
  const workspace = isRecord(raw['workspace']) ? raw['workspace'] : null
  const viewer = isRecord(raw['viewer']) ? raw['viewer'] : null

  if (event === null || workspace === null || viewer === null) {
    trace.push({ step: 'deny-by-default', detail: 'Malformed policy input' })
    return denied(fields, trace)
  }

  // Unknown policy version: refuse rather than guess. A future version may reorder
  // precedence, and applying v1 semantics to v2 rules would silently over-disclose.
  if (raw['policyVersion'] !== POLICY_VERSION) {
    trace.push({ step: 'deny-by-default', detail: `Unsupported policy version` })
    return denied(fields, trace)
  }

  const viewerIdentity: ViewerIdentity = {
    kind:
      viewer['kind'] === 'owner' ||
      viewer['kind'] === 'individual' ||
      viewer['kind'] === 'public'
        ? viewer['kind']
        : 'unauthenticated',
    contactId: typeof viewer['contactId'] === 'string' ? viewer['contactId'] : undefined,
    groupIds: Array.isArray(viewer['groupIds'])
      ? (viewer['groupIds'] as unknown[]).filter((g): g is string => typeof g === 'string')
      : undefined,
  }

  const lifecycle = event['lifecycle']
  if (lifecycle !== 'active') {
    // Trash is the owner's business; nobody else sees a deleted event at all.
    if (viewerIdentity.kind !== 'owner') {
      trace.push({ step: 'lifecycle', detail: `Event is ${String(lifecycle)}` })
      return denied(fields, trace)
    }
  }

  if (viewerIdentity.kind === 'owner') {
    trace.push({ step: 'owner', detail: 'Owner sees everything' })
    return {
      eventVisible: true,
      time: 'exact',
      fields: Object.freeze(
        Object.fromEntries(fields.map((f) => [f, 'visible'])) as Record<FieldName, FieldVisibility>,
      ),
      trace: Object.freeze(trace),
    }
  }

  // An unauthenticated viewer gets nothing unless a public rule explicitly grants it —
  // deny by default, not "fall back to the workspace default".
  const now = typeof raw['now'] === 'string' ? Date.parse(raw['now']) : Number.NaN
  if (!Number.isFinite(now)) {
    trace.push({ step: 'deny-by-default', detail: 'Invalid evaluation time' })
    return denied(fields, trace)
  }

  const candidates: VisibilityRule[] = []
  for (const rule of [...usableRules(event['rules']), ...usableRules(workspace['rules'])]) {
    if (!appliesTo(rule, viewerIdentity)) continue

    const state = windowState(rule, now)
    if (state === 'not-yet-revealed') {
      trace.push({ step: 'rule-not-yet-revealed', ruleId: rule.id, detail: 'Reveal time not reached' })
      continue
    }
    if (state === 'expired') {
      trace.push({ step: 'rule-expired', ruleId: rule.id, detail: 'Access window has closed' })
      continue
    }
    candidates.push(rule)
  }

  const winner = [...candidates].sort((a, b) => compareRules(a, b, fields))[0]

  if (winner !== undefined) {
    trace.push({
      step: TRACE_STEP[winner.audience],
      ruleId: winner.id,
      detail: `${winner.scope}-scoped ${winner.audience} rule applied`,
    })
    return materialise(winner.timeVis, winner.fields, fields, trace)
  }

  // No rule matched. A known individual or group member falls back to the workspace
  // default; an anonymous or public viewer does not, because the workspace default
  // describes what colleagues see, not what the internet sees.
  if (viewerIdentity.kind === 'individual') {
    trace.push({ step: 'workspace-default', detail: 'No matching rule; workspace default applied' })
    const wsTime =
      typeof workspace['timeVis'] === 'string' && workspace['timeVis'] in TIME_RESTRICTION
        ? (workspace['timeVis'] as TimeVisibility)
        : 'hidden'
    const wsFields = isRecord(workspace['fields'])
      ? (workspace['fields'] as Partial<Record<FieldName, FieldVisibility>>)
      : {}
    return materialise(wsTime, wsFields, fields, trace)
  }

  trace.push({ step: 'deny-by-default', detail: 'No rule grants this viewer access' })
  return denied(fields, trace)
}

function materialise(
  timeVis: TimeVisibility,
  ruleFields: Partial<Record<FieldName, FieldVisibility>>,
  fields: readonly FieldName[],
  trace: RuleTrace[],
): Decision {
  // Hidden time means the event does not exist for this viewer, so nothing else can be
  // visible either — otherwise a title could be disclosed for an event with no time.
  if (timeVis === 'hidden') {
    return denied(fields, trace)
  }

  // "Busy" means exactly that: a block of time and nothing else. A rule combining timeVis
  // 'busy' with a visible title is incoherent, and resolving it in the engine rather than
  // the renderer means every consumer — server redaction, View As, a future export —
  // agrees, instead of each deciding for itself.
  if (timeVis === 'busy') {
    return {
      eventVisible: true,
      time: 'busy',
      fields: Object.freeze(ALL_HIDDEN(fields)),
      trace: Object.freeze([...trace]),
    }
  }

  // A field absent from a rule is HIDDEN, never visible. Adding a new field to the product
  // must not silently expose it under every rule written before the field existed.
  const resolved = Object.fromEntries(
    fields.map((f) => [f, ruleFields[f] === 'visible' ? 'visible' : 'hidden']),
  ) as Record<FieldName, FieldVisibility>

  return {
    eventVisible: true,
    time: timeVis,
    fields: Object.freeze(resolved),
    trace: Object.freeze([...trace]),
  }
}
