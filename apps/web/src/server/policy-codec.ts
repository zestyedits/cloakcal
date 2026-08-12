import type { FieldName, FieldVisibility, TimeVisibility, VisibilityRule } from '@cloakcal/policy'
import { STANDARD_FIELDS } from '@cloakcal/policy'

/**
 * The boundary between how Postgres names things and how the policy engine names them.
 *
 * These are two vocabularies that happen to overlap, not one vocabulary in two places.
 * `cloaked_fields.field_name` is a database allowlist written in snake_case; `FieldName` is a
 * TypeScript union written in camelCase. They agree on five of six values and disagree on the
 * sixth, which is exactly the shape of mistake a cast hides.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS EXISTS TO FIX
 * ---------------------------------------------------------------------------
 *
 * `audience.ts` used to do `fieldName: f.fieldName as EventPayload['fields'][number]['fieldName']`.
 * A cast, so the compiler stopped asking. But redaction decides disclosure with
 * `decision.fields[field.fieldName] === 'visible'`, and the decision object is keyed by the
 * POLICY name. A field stored as `video_link` therefore looks up `decision.fields['video_link']`,
 * finds `undefined`, and is withheld from EVERY audience including the owner — permanently,
 * silently, with no error and no way to grant it.
 *
 * It has not bitten because the editor only writes title, location and notes today. It would
 * have bitten the moment video links shipped, and it would have looked like a policy bug
 * rather than a spelling one.
 *
 * Failing CLOSED is the right direction for a privacy engine, so the bug was invisible: the
 * safe failure mode is also the quiet one. That is the argument for translating explicitly
 * and rejecting anything unrecognised, rather than casting and hoping the two lists match.
 */

/**
 * Database `field_name` → policy `FieldName`.
 *
 * Only the entries that actually differ are listed; everything else is identical in both
 * vocabularies and passes through. Keeping the map minimal means a future divergence has to
 * be added here deliberately.
 */
const DB_TO_POLICY_FIELD: Readonly<Record<string, FieldName>> = {
  video_link: 'videoLink',
}

const POLICY_TO_DB_FIELD: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(DB_TO_POLICY_FIELD).map(([db, policy]) => [policy, db]),
)

const STANDARD = new Set<string>(STANDARD_FIELDS)

/**
 * Returns null for anything the engine cannot name.
 *
 * Null rather than a throw: a single unrecognised row must not take down a whole calendar
 * read. The caller drops it, which withholds — the safe direction — but it should also be
 * treated as a schema drift bug rather than as normal.
 */
export function toPolicyFieldName(dbFieldName: string): FieldName | null {
  const mapped = DB_TO_POLICY_FIELD[dbFieldName]
  if (mapped !== undefined) return mapped
  if (STANDARD.has(dbFieldName)) return dbFieldName as FieldName
  // The escape hatch both sides already share. `custom:` prefixes are opaque to the engine
  // and are compared as strings, so they need no translation.
  if (dbFieldName.startsWith('custom:')) return dbFieldName as FieldName
  return null
}

/** Policy `FieldName` → database `field_name`, for writes. */
export function toDbFieldName(fieldName: FieldName): string {
  return POLICY_TO_DB_FIELD[fieldName] ?? fieldName
}

/** The shape PostgREST returns from `visibility_rules`. */
export interface VisibilityRuleRow {
  readonly id: string
  readonly scope: string
  readonly event_id: string | null
  readonly audience: string
  readonly audience_ref: string | null
  readonly group_priority: number | null
  readonly time_vis: string
  readonly fields: unknown
  readonly reveal_at: string | null
  readonly expires_at: string | null
}

const AUDIENCES = new Set(['owner', 'individual', 'group', 'public'])
const TIME_VIS = new Set(['exact', 'busy', 'hidden'])

/**
 * A rule's `fields` column is jsonb, which means it is whatever was last written to it —
 * `unknown` until proven otherwise. Anything unrecognised is DROPPED rather than defaulted:
 * a key the engine cannot name has no defined meaning, and inventing one ("probably hidden",
 * "probably visible") would make the failure mode depend on a guess.
 *
 * Dropping resolves to "no rule grants this field", which withholds.
 */
function decodeFields(raw: unknown): Partial<Record<FieldName, FieldVisibility>> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}

  const out: Partial<Record<FieldName, FieldVisibility>> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value !== 'visible' && value !== 'hidden') continue
    const name = toPolicyFieldName(key)
    if (name === null) continue
    out[name] = value
  }
  return out
}

export class MalformedRuleError extends Error {
  constructor(id: string, reason: string) {
    super(`visibility rule ${id} is unusable: ${reason}`)
    this.name = 'MalformedRuleError'
  }
}

/**
 * One row → one `VisibilityRule`.
 *
 * THROWS on a malformed rule rather than skipping it, and that asymmetry with `decodeFields`
 * above is deliberate. An unknown FIELD KEY is a value the engine can safely ignore, because
 * ignoring it withholds. An unknown AUDIENCE or an out-of-range `time_vis` is different: the
 * row exists to restrict something, and silently dropping the whole rule would make the
 * calendar MORE visible than the user asked for. A rule we cannot understand must not become
 * a rule we do not apply.
 *
 * The database's own CHECK constraints make these unreachable in practice. They are here
 * because "unreachable" is a property of today's schema, and this function is what a future
 * migration would be caught by.
 */
export function toVisibilityRule(row: VisibilityRuleRow): VisibilityRule {
  if (row.scope !== 'workspace' && row.scope !== 'event') {
    throw new MalformedRuleError(row.id, `unknown scope ${row.scope}`)
  }
  if (!AUDIENCES.has(row.audience)) {
    throw new MalformedRuleError(row.id, `unknown audience ${row.audience}`)
  }
  if (!TIME_VIS.has(row.time_vis)) {
    throw new MalformedRuleError(row.id, `unknown time visibility ${row.time_vis}`)
  }
  if (row.audience === 'group' && row.group_priority === null) {
    // D8 breaks group ties by priority. Without one, two group rules have no defined order
    // and the engine's result would depend on row order out of Postgres.
    throw new MalformedRuleError(row.id, 'a group rule needs a priority')
  }

  return {
    id: row.id,
    scope: row.scope,
    audience: row.audience as VisibilityRule['audience'],
    audienceRef: row.audience_ref,
    groupPriority: row.group_priority,
    timeVis: row.time_vis as TimeVisibility,
    fields: decodeFields(row.fields),
    // Postgres hands back timestamptz as an ISO string; the engine compares it to `now` as a
    // string-parsed instant, so it is passed through untouched rather than round-tripped
    // through Date, which would drop sub-second precision and add a host-timezone hop.
    revealAt: row.reveal_at,
    expiresAt: row.expires_at,
  }
}

/** Split a workspace's rules the way `EvaluateInput` wants them: by scope, then by event. */
export function partitionRules(rows: readonly VisibilityRuleRow[]): {
  readonly workspace: readonly VisibilityRule[]
  readonly byEvent: ReadonlyMap<string, readonly VisibilityRule[]>
} {
  const workspace: VisibilityRule[] = []
  const byEvent = new Map<string, VisibilityRule[]>()

  for (const row of rows) {
    const rule = toVisibilityRule(row)
    if (rule.scope === 'workspace') {
      workspace.push(rule)
      continue
    }
    // `visibility_rules_scope_pair` guarantees event_id is present when scope is 'event',
    // so this is belt and braces — but an event rule filed under no event would otherwise
    // vanish, which again fails open.
    if (row.event_id === null) {
      throw new MalformedRuleError(row.id, 'an event rule needs an event')
    }
    const bucket = byEvent.get(row.event_id) ?? []
    bucket.push(rule)
    byEvent.set(row.event_id, bucket)
  }

  return { workspace, byEvent }
}
