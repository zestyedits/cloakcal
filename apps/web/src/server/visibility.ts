import 'server-only'
import type { VisibilityRule } from '@cloakcal/policy'
import { supabaseServer } from '@/lib/supabase/server'
import { partitionRules, type VisibilityRuleRow } from './policy-codec'
import type { CiphertextField } from './events'
import type { AudienceOption } from '@/lib/audiences'

// Re-exported so server callers have one import for the whole visibility surface.
export type { AudienceOption } from '@/lib/audiences'
export { audienceIdOf } from '@/lib/audiences'

/**
 * Load the audiences and rules the policy engine actually decides with.
 *
 * Replaces `DEMO_AUDIENCES` and `WORKSPACE_RULES` — two literal rules and four fictional
 * people that made View As a demonstration of the engine rather than a control on it.
 *
 * ---------------------------------------------------------------------------
 * THE NAMES COME BACK AS CIPHERTEXT, AND THAT IS THE WHOLE DESIGN
 * ---------------------------------------------------------------------------
 *
 * A contact row is an id, a workspace and timestamps (ADR 0004). Its name lives in
 * `cloaked_fields` under the `contact` subject type, so this function returns the sealed
 * bytes and the browser opens them — exactly as it does for an event title.
 *
 * The server therefore cannot sort contacts alphabetically, cannot search them, and cannot
 * label the audience picker. Those are the costs ADR 0004 accepted, in writing, and they show
 * up here rather than being quietly avoided by adding a plaintext column.
 */

export interface WorkspaceVisibility {
  readonly workspaceId: string
  readonly audiences: readonly AudienceOption[]
  readonly workspaceRules: readonly VisibilityRule[]
  readonly rulesByEvent: ReadonlyMap<string, readonly VisibilityRule[]>
  /**
   * Group membership, both ways round. `groupsByContact` is what the ENGINE needs — until
   * this was loaded, the calendar passed an empty map for real accounts, so a group rule
   * never applied when previewing an individual who belonged to one. `membersByGroup` is
   * what the settings checkboxes render.
   */
  readonly groupsByContact: ReadonlyMap<string, readonly string[]>
  readonly membersByGroup: ReadonlyMap<string, readonly string[]>
}

/** Owner and public always exist; they are not rows and cannot be deleted. */
const FIXED: readonly AudienceOption[] = [
  { id: 'owner', kind: 'owner' },
  { id: 'public', kind: 'public' },
]

export const EMPTY_VISIBILITY = (workspaceId: string): WorkspaceVisibility => ({
  workspaceId,
  audiences: FIXED,
  workspaceRules: [],
  rulesByEvent: new Map(),
  groupsByContact: new Map(),
  membersByGroup: new Map(),
})

export async function loadWorkspaceVisibility(
  workspaceId: string,
): Promise<WorkspaceVisibility> {
  const supabase = await supabaseServer()

  const [contactResult, groupResult, memberResult, ruleResult, nameResult] = await Promise.all([
    supabase.from('contacts').select('id').eq('workspace_id', workspaceId),
    supabase.from('contact_groups').select('id').eq('workspace_id', workspaceId),
    supabase
      .from('contact_group_members')
      .select('group_id, contact_id')
      .eq('workspace_id', workspaceId),
    supabase
      .from('visibility_rules')
      .select(
        'id, scope, event_id, audience, audience_ref, group_priority, time_vis, fields, reveal_at, expires_at',
      )
      .eq('workspace_id', workspaceId),
    // Both subject types in one round trip. `in` rather than two queries because the audience
    // picker needs every label at once and a waterfall here delays the whole page.
    supabase
      .from('cloaked_fields')
      .select('subject_type, subject_id, field_name, ciphertext, nonce, alg, key_version')
      .eq('workspace_id', workspaceId)
      .in('subject_type', ['contact', 'contact_group']),
  ])

  if (contactResult.error !== null) throw contactResult.error
  if (groupResult.error !== null) throw groupResult.error
  if (memberResult.error !== null) throw memberResult.error
  if (ruleResult.error !== null) throw ruleResult.error
  if (nameResult.error !== null) throw nameResult.error

  const groupsByContact = new Map<string, string[]>()
  const membersByGroup = new Map<string, string[]>()
  for (const row of (memberResult.data ?? []) as Array<{ group_id: string; contact_id: string }>) {
    groupsByContact.set(row.contact_id, [
      ...(groupsByContact.get(row.contact_id) ?? []),
      row.group_id,
    ])
    membersByGroup.set(row.group_id, [...(membersByGroup.get(row.group_id) ?? []), row.contact_id])
  }

  const sealed = new Map<string, CiphertextField>()
  for (const row of (nameResult.data ?? []) as Array<{
    subject_id: string
    field_name: string
    ciphertext: string
    nonce: string
    alg: string
    key_version: number
  }>) {
    sealed.set(row.subject_id, {
      fieldName: row.field_name,
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      alg: row.alg,
      keyVersion: row.key_version,
    })
  }

  const withName = (id: string, kind: AudienceOption['kind']): AudienceOption => {
    const nameField = sealed.get(id)
    return nameField === undefined ? { id, kind } : { id, kind, nameField }
  }

  const audiences: AudienceOption[] = [
    FIXED[0]!,
    ...((contactResult.data ?? []) as Array<{ id: string }>).map((c) =>
      withName(c.id, 'individual'),
    ),
    ...((groupResult.data ?? []) as Array<{ id: string }>).map((g) => withName(g.id, 'group')),
    FIXED[1]!,
  ]

  // `partitionRules` THROWS on a rule it cannot parse rather than skipping it, and that
  // propagates from here on purpose. A rule exists to restrict something, so dropping an
  // unreadable one would render the calendar MORE visible than the user asked for — failing
  // open, in the one place that must not. A page that errors is the safe outcome.
  const { workspace, byEvent } = partitionRules(
    (ruleResult.data ?? []) as unknown as VisibilityRuleRow[],
  )

  return {
    workspaceId,
    audiences,
    workspaceRules: workspace,
    rulesByEvent: byEvent,
    groupsByContact,
    membersByGroup,
  }
}
