import 'server-only'
import type { CalendarPage } from './events'
import { redactPage, type AudienceId, type RedactedPage } from './audience'
import {
  EMPTY_VISIBILITY,
  loadWorkspaceVisibility,
  audienceIdOf,
  type WorkspaceVisibility,
} from './visibility'
import {
  FIXTURE_AUDIENCES,
  FIXTURE_GROUPS,
  FIXTURE_NOW,
  FIXTURE_RULES,
} from './dev-fixture'

/**
 * THE audience-resolution-and-redaction step, extracted because two pages ran it and a
 * transcription is not a guarantee. `/` and the People preview must produce byte-identical
 * redactions for the same audience — a preview computed by a drifted copy of this pipeline
 * is the one failure a privacy product cannot afford, and this repo has already shipped
 * that class of bug twice (own-workspace, groupsByContact). One function, two callers.
 *
 * The requested audience is validated against the audiences that exist; an unknown one
 * resolves to 'owner' rather than to an audience with no rules, which would render as
 * "this person sees nothing" instead of "no such person".
 */
export interface ResolvedRedaction {
  readonly visibility: WorkspaceVisibility
  readonly audience: AudienceId
  readonly page: RedactedPage
  /** The instant the redaction was computed: fixed in fixture mode, request time otherwise. */
  readonly now: string
  /**
   * The membership map the engine JUST redacted with — fixture groups under the fixture,
   * the workspace's rows otherwise. Callers that hand a client the engine's inputs (the
   * visibility sheet, the contact file) must forward THIS map, not re-derive the fixture
   * split: the split existed in three places once, and three copies of a conditional is
   * how group rules shipped never applying on real accounts.
   */
  readonly groupsByContact: ReadonlyMap<string, readonly string[]>
}

export async function resolveAndRedact(
  calendarPage: CalendarPage,
  requested: AudienceId,
  fixtureMode: boolean,
): Promise<ResolvedRedaction> {
  const visibility =
    calendarPage.workspaceId === null
      ? {
          ...EMPTY_VISIBILITY('fixture'),
          audiences: FIXTURE_AUDIENCES,
          workspaceRules: FIXTURE_RULES,
        }
      : await loadWorkspaceVisibility(calendarPage.workspaceId)

  const audience: AudienceId = visibility.audiences.some((a) => audienceIdOf(a) === requested)
    ? requested
    : 'owner'

  const now = fixtureMode ? FIXTURE_NOW : new Date().toISOString()

  // Resolved ONCE and returned, so what the engine used and what a page forwards to the
  // client are the same value by construction rather than by repeated conditionals.
  const groupsByContact = fixtureMode ? FIXTURE_GROUPS : visibility.groupsByContact

  const page = redactPage(calendarPage, audience, now, {
    workspaceId: visibility.workspaceId,
    workspaceRules: visibility.workspaceRules,
    rulesByEvent: visibility.rulesByEvent,
    groupsByContact,
    // No rule means hidden. A calendar that defaulted to visible would disclose
    // everything the moment someone was added as a contact.
    defaultTimeVis: 'hidden',
  })

  return { visibility, audience, page, now, groupsByContact }
}
