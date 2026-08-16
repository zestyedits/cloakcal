import { supabaseBrowser } from '@/lib/supabase/client'
import { updateDemoPrefs } from '@/lib/demo-prefs'
import type { CalendarPrefs } from '@/server/settings'

/**
 * THE write path for the display preferences, wherever the control lives.
 *
 * Two callers today — the Settings card and the calendar's "make this my default view"
 * button — and they must not each carry their own copy of "demo writes a cookie, an
 * account writes the RPC". That shape of duplication is what put two live audience pickers
 * on the same screen bound to the same state; one module is how it stays a single answer.
 *
 * No React, no state, no error copy: callers own how a failure is shown, because a card
 * with an inline error slot and a single button in the chrome want different treatments.
 * Throws the RPC error so the caller can run it through `rpcErrorMessage`.
 */

export interface PrefsTarget {
  /** The dev fixture, which has no row to write to and uses a cookie instead. */
  readonly demo: boolean
  /** Null for a signed-in user whose workspace does not exist yet: nowhere to write. */
  readonly workspaceId: string | null
}

export async function saveCalendarPrefs(
  target: PrefsTarget,
  patch: Partial<CalendarPrefs>,
): Promise<void> {
  if (target.demo) {
    updateDemoPrefs(patch)
    return
  }
  if (target.workspaceId === null) return

  // Null means "leave unchanged" in 0022, which is why each control can write one field
  // without reading the other three first.
  const { error } = await supabaseBrowser().rpc('set_workspace_prefs', {
    p_workspace_id: target.workspaceId,
    p_timezone: patch.timezone ?? null,
    p_week_start: patch.weekStart ?? null,
    p_default_view: patch.defaultView ?? null,
    p_keyboard_shortcuts: patch.keyboardShortcuts ?? null,
    p_holiday_region: patch.holidayRegion ?? null,
  })
  if (error !== null) throw error
}

/** Is there anywhere at all to put a preference? Controls hide themselves when not. */
export const canSavePrefs = (target: PrefsTarget): boolean =>
  target.demo || target.workspaceId !== null
