/**
 * The visibility policy contract.
 *
 * Deliberately dependency-free and isomorphic. This package is the ONLY place a
 * field-visibility decision is made (plan D2): the server calls it to redact outgoing
 * payloads, the client calls the same code for "View As", and a contract test asserts the
 * two produce identical output. Postgres RLS is coarse row authorisation and never
 * appears here.
 *
 * Nothing in this file may reference Tier B content. The engine decides what a viewer may
 * see using metadata alone — it never handles the values themselves.
 */

export const POLICY_VERSION = 'v1' as const
export type PolicyVersion = typeof POLICY_VERSION

export type StandardFieldName =
  | 'title'
  | 'location'
  | 'attendees'
  | 'notes'
  | 'videoLink'
  | 'attachments'

export type FieldName = StandardFieldName | `custom:${string}`

export const STANDARD_FIELDS: readonly StandardFieldName[] = [
  'title',
  'location',
  'attendees',
  'notes',
  'videoLink',
  'attachments',
]

export type FieldVisibility = 'visible' | 'hidden'

/**
 * Time is not a field, it is its own axis.
 *
 * `busy` still discloses start and end — that is the whole point of a busy block — while
 * revealing nothing else. Modelling it as a field would make "show my time but not my
 * title" inexpressible, which is the product's central use case.
 */
export type TimeVisibility = 'exact' | 'busy' | 'hidden'

export type AudienceKind = 'owner' | 'individual' | 'group' | 'public'

export interface ViewerIdentity {
  readonly kind: 'owner' | 'individual' | 'public' | 'unauthenticated'
  /** Contact id, when the viewer is a known individual. */
  readonly contactId?: string | undefined
  /** Groups the viewer belongs to. Order is irrelevant; D8 decides ties deterministically. */
  readonly groupIds?: readonly string[] | undefined
}

export interface VisibilityRule {
  readonly id: string
  readonly scope: 'workspace' | 'event'
  readonly audience: AudienceKind
  /** Contact id for `individual`, group id for `group`, null otherwise. */
  readonly audienceRef: string | null
  /** D8 tiebreak. Required for group rules; lower wins. */
  readonly groupPriority: number | null
  readonly timeVis: TimeVisibility
  readonly fields: Partial<Record<FieldName, FieldVisibility>>
  /** Delayed reveal: the rule is inert before this instant. */
  readonly revealAt: string | null
  /** Temporary access: the rule is inert at and after this instant. */
  readonly expiresAt: string | null
}

export interface EventPolicyFacts {
  readonly eventId: string
  readonly workspaceId: string
  readonly lifecycle: 'active' | 'trashed' | 'purged'
  /** Event-scoped rules only. */
  readonly rules: readonly VisibilityRule[]
}

export interface WorkspaceDefaults {
  readonly workspaceId: string
  readonly timeVis: TimeVisibility
  readonly fields: Partial<Record<FieldName, FieldVisibility>>
  /** Workspace-scoped rules only. */
  readonly rules: readonly VisibilityRule[]
}

export interface EvaluateInput {
  readonly event: EventPolicyFacts
  readonly viewer: ViewerIdentity
  readonly workspace: WorkspaceDefaults
  /** ISO instant. Passed in, never read from the ambient clock, so time rules are testable. */
  readonly now: string
  readonly policyVersion: PolicyVersion
  /** Custom fields in play for this event, so the decision covers them explicitly. */
  readonly customFields?: readonly `custom:${string}`[] | undefined
}

/**
 * Why a decision came out the way it did.
 *
 * Not a debugging luxury: this is what renders "Clients will see the time and title;
 * location and attendees remain hidden", and what the audit log records. A decision a user
 * cannot be shown the reason for is one they cannot trust.
 */
export interface RuleTrace {
  readonly step:
    | 'owner'
    | 'lifecycle'
    | 'individual-rule'
    | 'group-rule'
    | 'event-default'
    | 'workspace-default'
    | 'deny-by-default'
    | 'rule-not-yet-revealed'
    | 'rule-expired'
  readonly ruleId?: string | undefined
  readonly detail: string
}

export interface Decision {
  readonly eventVisible: boolean
  readonly time: TimeVisibility
  readonly fields: Readonly<Record<FieldName, FieldVisibility>>
  readonly trace: readonly RuleTrace[]
}
