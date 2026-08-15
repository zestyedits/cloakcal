import 'server-only'
import { supabaseServer } from '@/lib/supabase/server'
import { isCalendarView } from '@/lib/calendar-views'
import type { CalendarView } from '@/components/calendar-screen'
import type { WeekStart } from './range'
import type { CiphertextField } from './events'
import { loadWorkspaceVisibility, type WorkspaceVisibility } from './visibility'

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


/**
 * The four preferences that frame a calendar render, WITHOUT saying where they came from.
 *
 * Split out from WorkspacePrefs so the demo's cookie-backed prefs (lib/demo-prefs.ts) can
 * satisfy the same shape: `app/page.tsx` then reads one object and does not branch on
 * whether there is an account behind it. The workspace id is the part that genuinely
 * differs, and it stays below — a demo has no row to write to, and code that needs an id
 * should not be handed a plausible-looking fake one.
 */
export interface CalendarPrefs {
  readonly timezone: string
  readonly weekStart: WeekStart
  /** The view `/` opens on when the URL names none. `?view=` always wins. */
  readonly defaultView: CalendarView
  /** Single-key shortcuts are opt-in (WCAG 2.1.4 route one): off until turned on. */
  readonly keyboardShortcuts: boolean
}

export interface WorkspacePrefs extends CalendarPrefs {
  readonly workspaceId: string
}


export async function loadWorkspacePrefs(): Promise<WorkspacePrefs | null> {
  const supabase = await supabaseServer()
  const { data } = await supabase
    .from('workspaces')
    .select('id, timezone, week_start, default_view, keyboard_shortcuts')
    .eq('lifecycle', 'active')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle<{
      id: string
      timezone: string
      week_start: number
      default_view: string
      keyboard_shortcuts: boolean
    }>()

  if (data === null) return null

  const weekStart = (
    data.week_start >= 0 && data.week_start <= 6 ? data.week_start : 0
  ) as WeekStart

  return {
    workspaceId: data.id,
    timezone: data.timezone,
    weekStart,
    // The check constraint makes anything else unrepresentable; the fallback is for the
    // same reason week_start has one — a clamp beats trusting a cast. The allowlist is
    // THE one in lib/calendar-views.ts, not a local copy: this used to be one of four.
    defaultView: isCalendarView(data.default_view) ? data.default_view : 'agenda',
    keyboardShortcuts: data.keyboard_shortcuts,
  }
}

/**
 * Everything the settings screen renders, in one load.
 *
 * Names come back as CIPHERTEXT throughout — calendar display names, contact names, group
 * labels — and are opened in the browser, exactly as the calendar does it. The server
 * component that calls this touches Tier A facts and sealed bytes only.
 */

export interface SettingsCalendar {
  readonly id: string
  readonly colorToken: string
  readonly isDefault: boolean
  readonly fields: readonly CiphertextField[]
}

export interface SettingsDevice {
  readonly id: string
  readonly label: string
  readonly lastSeenAt: string | null
  readonly revokedAt: string | null
}

/**
 * NO `devices` here. They moved to /settings/security with the flows that care about them,
 * and this kept fetching them for a screen that no longer renders one — a query nobody
 * read, awaited inside the Promise.all, on the page this pass exists to make feel quick.
 * `loadDevices()` below is the one caller's one query.
 */
export interface SettingsData {
  readonly prefs: WorkspacePrefs | null
  readonly calendars: readonly SettingsCalendar[]
  readonly visibility: WorkspaceVisibility | null
}

export async function loadSettingsData(): Promise<SettingsData> {
  const prefs = await loadWorkspacePrefs()
  const supabase = await supabaseServer()

  if (prefs === null) return { prefs: null, calendars: [], visibility: null }

  const [calendarResult, nameResult, visibility] = await Promise.all([
    supabase
      .from('calendars')
      .select('id, color_token, is_default')
      .eq('workspace_id', prefs.workspaceId)
      .eq('lifecycle', 'active')
      .order('sort_order', { ascending: true }),
    supabase
      .from('cloaked_fields')
      .select('subject_id, field_name, ciphertext, nonce, alg, key_version')
      .eq('workspace_id', prefs.workspaceId)
      .eq('subject_type', 'calendar'),
    loadWorkspaceVisibility(prefs.workspaceId),
  ])

  if (calendarResult.error !== null) throw calendarResult.error
  if (nameResult.error !== null) throw nameResult.error

  const fieldsByCalendar = new Map<string, CiphertextField[]>()
  for (const row of (nameResult.data ?? []) as Array<{
    subject_id: string
    field_name: string
    ciphertext: string
    nonce: string
    alg: string
    key_version: number
  }>) {
    const list = fieldsByCalendar.get(row.subject_id) ?? []
    list.push({
      fieldName: row.field_name,
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      alg: row.alg,
      keyVersion: row.key_version,
    })
    fieldsByCalendar.set(row.subject_id, list)
  }

  const calendars = ((calendarResult.data ?? []) as Array<{
    id: string
    color_token: string
    is_default: boolean
  }>).map((row) => ({
    id: row.id,
    colorToken: row.color_token,
    isDefault: row.is_default,
    fields: fieldsByCalendar.get(row.id) ?? [],
  }))

  return { prefs, calendars, visibility }
}

/** Devices, for /settings/security — the only screen that renders them. */
export async function loadDevices(): Promise<readonly SettingsDevice[]> {
  const supabase = await supabaseServer()
  const { data, error } = await supabase
    .from('devices')
    .select('id, label, last_seen_at, revoked_at')
    .order('created_at', { ascending: true })
  if (error !== null) throw error
  return toDevices(data)
}

const toDevices = (rows: unknown): SettingsDevice[] =>
  ((rows ?? []) as Array<{
    id: string
    label: string
    last_seen_at: string | null
    revoked_at: string | null
  }>).map((row) => ({
    id: row.id,
    label: row.label,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  }))
