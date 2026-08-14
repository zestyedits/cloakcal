import 'server-only'
import { Temporal } from '@js-temporal/polyfill'
import { getCalendarPage } from './events'
import { redactPage, type AudienceId, type RedactedPage } from './audience'
import {
  EMPTY_VISIBILITY,
  loadWorkspaceVisibility,
  audienceIdOf,
  type WorkspaceVisibility,
} from './visibility'
import { loadWorkspacePrefs } from './settings'
import { currentWeek, safeTimezone } from './range'
import {
  DEMO_WEEK,
  FIXTURE_AUDIENCES,
  FIXTURE_GROUPS,
  FIXTURE_RULES,
  isDevFixtureEnabled,
} from './dev-fixture'
import { supabaseServer } from '@/lib/supabase/server'

/**
 * The People pages' one loader: the current week, redacted for the audience the page is
 * ABOUT. This is deliberately the same pipeline `/` uses — getCalendarPage, then the
 * policy engine via redactPage — because a preview computed by a second render path is a
 * preview that can disagree with what the person actually receives, which is the one
 * failure a privacy product cannot afford (the same reasoning that keeps rule 3 alive).
 *
 * The week is anchored on NOW rather than a ?date= because the page answers "what does
 * this person see", and the honest sample of that is the week being lived in.
 */
export interface PeopleData {
  readonly page: RedactedPage
  readonly visibility: WorkspaceVisibility
  readonly timezone: string
  readonly fixtureMode: boolean
  readonly email: string
  /** The instant the preview was computed, for the "as of now" label. */
  readonly previewedAt: string
}

export async function loadPeopleData(audience: AudienceId): Promise<PeopleData | null> {
  const fixtureMode = isDevFixtureEnabled()

  let email = ''
  if (!fixtureMode) {
    const supabase = await supabaseServer()
    const { data } = await supabase.auth.getUser()
    if (data.user === null) return null
    email = data.user.email ?? ''
  }

  const prefs = fixtureMode ? null : await loadWorkspacePrefs()
  const timezone = safeTimezone(prefs?.timezone)
  const range = fixtureMode ? DEMO_WEEK : currentWeek(timezone, prefs?.weekStart ?? 0)

  const calendarPage = await getCalendarPage(range, timezone)
  const visibility =
    calendarPage.workspaceId === null
      ? {
          ...EMPTY_VISIBILITY('fixture'),
          audiences: FIXTURE_AUDIENCES,
          workspaceRules: FIXTURE_RULES,
        }
      : await loadWorkspaceVisibility(calendarPage.workspaceId)

  // Same validation as `/`: an audience that does not exist falls back to owner rather
  // than rendering "this person sees nothing" for a person who is not there at all.
  const resolved: AudienceId = visibility.audiences.some((a) => audienceIdOf(a) === audience)
    ? audience
    : 'owner'
  if (resolved !== audience) return null

  const now = fixtureMode
    ? '2026-05-19T08:00:00-04:00'
    : Temporal.Now.instant().toString()

  const page = redactPage(calendarPage, resolved, now, {
    workspaceId: visibility.workspaceId,
    workspaceRules: visibility.workspaceRules,
    rulesByEvent: visibility.rulesByEvent,
    groupsByContact: fixtureMode ? FIXTURE_GROUPS : visibility.groupsByContact,
    defaultTimeVis: 'hidden',
  })

  return { page, visibility, timezone, fixtureMode, email, previewedAt: now }
}
