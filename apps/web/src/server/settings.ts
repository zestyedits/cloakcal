import 'server-only'
import { supabaseServer } from '@/lib/supabase/server'
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

export type CalendarViewPref = 'agenda' | 'week' | 'day' | 'month'

export interface WorkspacePrefs {
  readonly workspaceId: string
  readonly timezone: string
  readonly weekStart: WeekStart
  /** The view `/` opens on when the URL names none. `?view=` always wins. */
  readonly defaultView: CalendarViewPref
  /** Single-key shortcuts are opt-in (WCAG 2.1.4 route one): off until turned on. */
  readonly keyboardShortcuts: boolean
}

const VIEW_PREFS: readonly CalendarViewPref[] = ['agenda', 'week', 'day', 'month']

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
    // same reason week_start has one — a clamp beats trusting a cast.
    defaultView: VIEW_PREFS.includes(data.default_view as CalendarViewPref)
      ? (data.default_view as CalendarViewPref)
      : 'agenda',
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

export interface SettingsData {
  readonly prefs: WorkspacePrefs | null
  readonly calendars: readonly SettingsCalendar[]
  readonly visibility: WorkspaceVisibility | null
  readonly devices: readonly SettingsDevice[]
}

export async function loadSettingsData(): Promise<SettingsData> {
  // Prefs and devices start together — devices are user-scoped, not workspace-scoped, so
  // neither needs the other, and this page is the first thing a settings click waits on.
  const prefsPromise = loadWorkspacePrefs()
  const supabase = await supabaseServer()

  const devicesPromise = supabase
    .from('devices')
    .select('id, label, last_seen_at, revoked_at')
    .order('created_at', { ascending: true })

  const prefs = await prefsPromise

  if (prefs === null) {
    const devices = await devicesPromise
    if (devices.error !== null) throw devices.error
    return { prefs: null, calendars: [], visibility: null, devices: toDevices(devices.data) }
  }

  const [calendarResult, nameResult, visibility, deviceResult] = await Promise.all([
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
    devicesPromise,
  ])

  if (calendarResult.error !== null) throw calendarResult.error
  if (nameResult.error !== null) throw nameResult.error
  if (deviceResult.error !== null) throw deviceResult.error

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

  return { prefs, calendars, visibility, devices: toDevices(deviceResult.data) }
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
