import 'server-only'
import { isHolidayPreference, type HolidayPreference } from '@cloakcal/domain'
import { supabaseServer } from '@/lib/supabase/server'
import { isCalendarView } from '@/lib/calendar-views'
import { planById } from '@/lib/plans'
import type { SettingsSummary } from '@/lib/settings-sections'
import type { CalendarView } from '@/components/calendar-screen'
import type { WeekStart } from './range'
import type { CiphertextField } from './events'
import { loadWorkspaceVisibility, type WorkspaceVisibility } from './visibility'
import { loadPlan } from './plan'
import { describeWeek, loadAvailability } from './availability'

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
  /**
   * Which country's public holidays the calendar draws. `auto` follows the timezone.
   *
   * Framing, like the other four — a country code the server already knows more precisely
   * from `timezone`. Holidays are never events: nothing here is stored, owned or cloaked.
   */
  readonly holidayRegion: HolidayPreference
}

export interface WorkspacePrefs extends CalendarPrefs {
  readonly workspaceId: string
}


/** Everything except the newest column, which a not-yet-migrated database lacks. */
const PREFS_COLUMNS = 'id, timezone, week_start, default_view, keyboard_shortcuts'

interface PrefsRow {
  id: string
  timezone: string
  week_start: number
  default_view: string
  keyboard_shortcuts: boolean
  holiday_region?: string
}

/**
 * THE READ TOLERATES A DATABASE THAT HAS NOT RUN 0026 YET, and that is not defensive
 * padding — it is the fix for a real ordering hazard this function already had.
 *
 * Vercel deploys on a push to `main`; migrations are applied by hand. So there is always a
 * window where the new code is live and the new column is not, and PostgREST answers a
 * select naming an unknown column with a 400. This function used to destructure `data` and
 * DROP the error, so that 400 arrived as `data === null` — indistinguishable from "this user
 * has no workspace". The consequence was silent and wide: every signed-in user would fall
 * back to the default timezone, week start and view, `workspaceId` would be null so every
 * preference control would disable itself, and Settings would say "Not set up yet" to
 * someone whose account is entirely fine.
 *
 * So: ask for the new column, and if the database does not have it yet, ask again without
 * it and treat the preference as its default. One extra round trip, only ever in the window
 * between deploy and migration, and only until the migration lands.
 */
export async function loadWorkspacePrefs(): Promise<WorkspacePrefs | null> {
  const supabase = await supabaseServer()

  const query = (columns: string) =>
    supabase
      .from('workspaces')
      .select(columns)
      .eq('lifecycle', 'active')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle<PrefsRow>()

  let { data, error } = await query(`${PREFS_COLUMNS}, holiday_region`)

  // 42703 is undefined_column. Anything else is a real failure and keeps the old behaviour
  // of returning null rather than inventing a workspace.
  if (error !== null && error.code === '42703') {
    ;({ data } = await query(PREFS_COLUMNS))
  }

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
    // Clamped like the two above, and for the same reason: a CHECK constraint behind the
    // column is not a reason to trust the string this side of the wire.
    holidayRegion: isHolidayPreference(data.holiday_region) ? data.holiday_region : 'auto',
  }
}

/**
 * What each settings screen loads.
 *
 * Names come back as CIPHERTEXT throughout — calendar display names, contact names, group
 * labels — and are opened in the browser, exactly as the calendar does it. Every server
 * component below touches Tier A facts and sealed bytes only.
 *
 * ONE LOADER PER SCREEN, since the seven-card accordion became four doors. `loadSettingsData`
 * fetched calendars, visibility, plan and availability together because one page rendered all
 * four; four pages now render disjoint subsets, and the hub renders none of them.
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
 * THE HUB'S FOUR LINES, and nothing else.
 *
 * Every query here is a head count. The hub renders no calendar name, no contact name and no
 * group label, so it needs no ciphertext, no CloakProvider and no client JavaScript — which
 * is what lets a page of four links be a plain server component. Returning a name from here
 * would quietly undo that.
 *
 * Null means there are no account facts to state: a signed-in user whose workspace row does
 * not exist yet. The caller falls back to each door's `pending` line rather than printing a
 * confident zero.
 */
export async function loadSettingsSummary(): Promise<SettingsSummary | null> {
  const prefs = await loadWorkspacePrefs()
  if (prefs === null) return null

  const supabase = await supabaseServer()
  const count = (table: string) => supabase.from(table).select('id', { count: 'exact', head: true })

  const [calendars, contacts, rules, passkeys, plan] = await Promise.all([
    count('calendars').eq('workspace_id', prefs.workspaceId).eq('lifecycle', 'active'),
    count('contacts').eq('workspace_id', prefs.workspaceId),
    /*
     * `.is('event_id', null)` — WORKSPACE-SCOPED RULES ONLY, matching the split
     * `partitionRules` makes. A bare count folds in every per-event rule as well, and the hub
     * would print a number the Privacy page's own list contradicts.
     */
    count('visibility_rules').eq('workspace_id', prefs.workspaceId).is('event_id', null),
    /*
     * Passkeys are the honest answer to "can I still get in", and the only one on offer:
     * nothing records whether a recovery phrase was ever written down, so the hub must not
     * imply it does. Head count only, and the select stays `id` — a wrap row is key material
     * and no summary line needs to see one. Same shape as cloak-session's last-way-in check.
     */
    count('root_key_wraps').eq('kind', 'passkey'),
    loadPlan(prefs.workspaceId),
  ])

  const n = (result: { count: number | null }): number => result.count ?? 0
  const plural = (value: number, one: string, many: string): string =>
    `${value} ${value === 1 ? one : many}`

  const people = n(contacts)
  const passkeyCount = n(passkeys)

  return {
    privacy:
      people === 0
        ? 'Nobody yet'
        : `${plural(people, 'person', 'people')} · ${plural(n(rules), 'default rule', 'default rules')}`,
    calendar: `${plural(n(calendars), 'calendar', 'calendars')} · ${prefs.timezone.replaceAll('_', ' ')}`,
    security:
      passkeyCount === 0
        ? 'Password and recovery phrase, no passkey'
        : `Password, recovery phrase, ${plural(passkeyCount, 'passkey', 'passkeys')}`,
    plan: planById(plan).name,
  }
}

/** /settings/privacy: the default visibility rules, and the people they name. */
export interface PrivacySettings {
  readonly prefs: WorkspacePrefs | null
  readonly visibility: WorkspaceVisibility | null
}

export async function loadPrivacySettings(): Promise<PrivacySettings> {
  const prefs = await loadWorkspacePrefs()
  if (prefs === null) return { prefs: null, visibility: null }
  return { prefs, visibility: await loadWorkspaceVisibility(prefs.workspaceId) }
}

/** /settings/calendar: the calendars, the display preferences, and one availability line. */
export interface CalendarSettings {
  readonly prefs: WorkspacePrefs | null
  readonly calendars: readonly SettingsCalendar[]
  /**
   * The Availability row's state, e.g. "Mon to Fri, 9:00 AM to 5:00 PM".
   *
   * A STRING, not the week: this page shows one line and the editor lives on its own route
   * that loads its own copy. Shipping the whole schedule to a screen rendering a summary of
   * it is the same over-fetch that once had this module loading devices nothing rendered.
   */
  readonly availability: string
}

export async function loadCalendarSettings(): Promise<CalendarSettings> {
  const prefs = await loadWorkspacePrefs()
  const supabase = await supabaseServer()

  if (prefs === null) {
    return { prefs: null, calendars: [], availability: describeWeek(await loadAvailability(null)) }
  }

  const [calendarResult, nameResult, availability] = await Promise.all([
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
    loadAvailability(prefs.workspaceId),
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

  return { prefs, calendars, availability: describeWeek(availability) }
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
