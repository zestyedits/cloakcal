import 'server-only'
import { getCalendarPage } from './events'
import type { AudienceId, RedactedPage } from './audience'
import type { WorkspaceVisibility } from './visibility'
import { resolveAndRedact } from './redaction'
import { loadWorkspacePrefs } from './settings'
import { currentWeek, safeTimezone } from './range'
import { DEMO_WEEK, isDevFixtureEnabled } from './dev-fixture'
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

  // The shared pipeline `/` uses — sameness by construction. It resolves an unknown
  // audience to 'owner'; for this loader that downgrade means "no such person", which the
  // caller renders as the house 404.
  const { visibility, audience: resolved, page, now } = await resolveAndRedact(
    calendarPage,
    audience,
    fixtureMode,
  )
  if (resolved !== audience) return null

  return { page, visibility, timezone, fixtureMode, email, previewedAt: now }
}
