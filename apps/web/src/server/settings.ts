import 'server-only'
import { supabaseServer } from '@/lib/supabase/server'
import type { WeekStart } from './range'

/**
 * Workspace preferences, read server-side because the server needs them BEFORE it can do
 * anything else: the timezone frames which week a query spans, and week_start decides
 * where that week begins. A preference the server cannot read would have to live in the
 * browser, and then the first render would always be framed wrong.
 *
 * "Which workspace" is the same definition `getCalendarPage` uses — the oldest active one
 * — and the two must keep agreeing, or the calendar would render one workspace's events
 * framed in another's timezone.
 */

export interface WorkspacePrefs {
  readonly workspaceId: string
  readonly timezone: string
  readonly weekStart: WeekStart
}

export async function loadWorkspacePrefs(): Promise<WorkspacePrefs | null> {
  const supabase = await supabaseServer()
  const { data } = await supabase
    .from('workspaces')
    .select('id, timezone, week_start')
    .eq('lifecycle', 'active')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle<{ id: string; timezone: string; week_start: number }>()

  if (data === null) return null

  const weekStart = (
    data.week_start >= 0 && data.week_start <= 6 ? data.week_start : 0
  ) as WeekStart

  return { workspaceId: data.id, timezone: data.timezone, weekStart }
}
