import 'server-only'
import { supabaseServer } from '@/lib/supabase/server'
import { isDevFixtureEnabled } from './dev-fixture'
import { DEFAULT_PLAN_ID, isPlanId, type PlanId } from '@/lib/plans'

/**
 * Which plan an account is on.
 *
 * ITS OWN MODULE, not a function in server/settings.ts, and the separation says the same
 * thing migration 0024 says by using its own table: settings.ts holds PREFERENCES, which are
 * facts the user states about themselves and writes through `set_workspace_prefs`. A plan is
 * a fact stated ABOUT the user, which they must not be able to write. Putting the two
 * loaders side by side would invite exactly the merge the schema exists to prevent.
 *
 * ABSENCE MEANS FREE, and that is the schema's design rather than a fallback papering over
 * a missing row (0024's header explains why there is no bootstrap insert). Every account
 * today has no row, so every account is free, with no backfill and nothing to provision.
 */

/**
 * Returns a PlanId and nothing else.
 *
 * An `AccountPlan { planId, source }` wrapper lived here first, carrying where the answer
 * came from — 'stored' | 'default' | 'demo'. Nothing rendered it, nothing logged it and no
 * test asserted on it, so it was a shape three call sites had to unwrap for no reader. The
 * distinction it recorded is real but it is not this function's to publish: every branch
 * below already says which case it is, in the one place anyone debugging would look.
 */
export async function loadPlan(workspaceId: string | null): Promise<PlanId> {
  // The fixture branch comes FIRST and never touches supabaseServer(), same as
  // getCalendarPage. CI has no Supabase variables, so reaching for a client here would
  // throw during a build rather than return a plan.
  //
  // The demo's plan is a constant and must never be a cookie. lib/demo-prefs.ts draws its
  // line at display framing — the Tier A facts a real account keeps in plaintext columns —
  // and a plan is the one fact in this product that is not the user's to state. A
  // cookie-backed plan would model precisely the capability 0024 spends a whole table to
  // remove, and would be the pattern whoever wires the real thing copies.
  if (isDevFixtureEnabled()) return DEFAULT_PLAN_ID

  if (workspaceId === null) return DEFAULT_PLAN_ID

  /*
   * A BILLING LOOKUP MUST NOT 500 THE CALENDAR, and the try covers the CLIENT as well as the
   * query. Every other loader here throws on error, which is right for them — a failed prefs
   * read renders the week in the wrong timezone, so failing loudly beats rendering a lie.
   * This one degrades, and the degraded answer is the generous one: the worst case is a
   * paying account briefly shown as free, never a free account shown as paid.
   *
   * `supabaseServer()` throws when the environment is not configured, which is a different
   * failure from a query error and would otherwise escape this function and land in the
   * error boundary — making the comment above a claim the code did not keep.
   */
  try {
    const supabase = await supabaseServer()
    const { data, error } = await supabase
      .from('subscriptions')
      .select('plan')
      .eq('workspace_id', workspaceId)
      .maybeSingle<{ plan: string }>()

    if (error !== null || data === null) return DEFAULT_PLAN_ID

    // Clamped even though a CHECK constraint stands behind it, exactly as loadWorkspacePrefs
    // clamps default_view. A clamp beats trusting a cast.
    return isPlanId(data.plan) ? data.plan : DEFAULT_PLAN_ID
  } catch {
    return DEFAULT_PLAN_ID
  }
}

/**
 * The whole row, for the one screen that manages a subscription rather than labelling one.
 *
 * A SIBLING RATHER THAN A WIDER `loadPlan`, and the header above says why in advance: an
 * `AccountPlan { planId, source }` shape lived here once and was deleted because three call
 * sites had to unwrap it for no reader. Three of the four call sites still want one word for
 * a badge. Widening now would re-add exactly that, with more fields, and would make every
 * calendar render select six columns and carry the retry below into the hot path. Nothing
 * calls both.
 *
 * `degraded` IS THE THIRD ANSWER, and it exists because "we could not read this" and "you are
 * on Free" are different facts that `loadPlan` is obliged to conflate. That conflation is
 * correct for a badge — a billing lookup must not 500 the calendar, and a sidebar showing
 * Free for one render is a small lie. It is NOT correct on a page carrying a purchase button:
 * a paying customer shown an upgrade control, who presses it, is charged twice. So the plan
 * screen refuses to draw any purchase or management control while this is true.
 *
 * Note that "no row" is NOT degraded. Absence means Free by design (0024 has no bootstrap
 * insert), and it is the normal state of every account in existence today.
 */
export interface SubscriptionRow {
  readonly plan: PlanId
  readonly providerCustomerId: string | null
  readonly providerSubscriptionId: string | null
  /** Raw and unmapped, exactly as 0028 stores it. A status we do not recognise is not ours to rename. */
  readonly providerStatus: string | null
  /** ISO instant, never a Date. */
  readonly currentPeriodEnd: string | null
  readonly cancelAtPeriodEnd: boolean
  readonly degraded: boolean
}

/** What a read that told us nothing must fall back to. Free, and honest about not knowing. */
const UNREADABLE: SubscriptionRow = {
  plan: DEFAULT_PLAN_ID,
  providerCustomerId: null,
  providerSubscriptionId: null,
  providerStatus: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  degraded: true,
}

/** No row at all: Free, and that is a fact rather than a failure. */
const NO_ROW: SubscriptionRow = { ...UNREADABLE, degraded: false }

const PLAN_ONLY = 'plan'
const FULL_ROW =
  'plan, provider_customer_id, provider_subscription_id, provider_status, current_period_end, cancel_at_period_end'

interface RawSubscription {
  plan?: unknown
  provider_customer_id?: unknown
  provider_subscription_id?: unknown
  provider_status?: unknown
  current_period_end?: unknown
  cancel_at_period_end?: unknown
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null

/**
 * Row to shape, as a pure function so it can be tested without a database or a network.
 *
 * `degraded` is passed in rather than inferred, because the two things that set it — a caught
 * error and a fired 42703 retry — are both facts about the QUERY rather than about the row.
 */
export function readSubscriptionRow(raw: RawSubscription, degraded: boolean): SubscriptionRow {
  return {
    // Clamped for the same reason loadPlan clamps: a CHECK constraint behind the column is
    // not a reason to trust the string this side of the wire.
    plan: isPlanId(raw.plan) ? raw.plan : DEFAULT_PLAN_ID,
    providerCustomerId: text(raw.provider_customer_id),
    providerSubscriptionId: text(raw.provider_subscription_id),
    providerStatus: text(raw.provider_status),
    currentPeriodEnd: text(raw.current_period_end),
    // The column is `not null default false`, so `undefined` here means the SELECT did not
    // ask for it — i.e. the retry below fired. Coerce rather than trust, and never to true.
    cancelAtPeriodEnd: raw.cancel_at_period_end === true,
    degraded,
  }
}

export async function loadSubscription(workspaceId: string | null): Promise<SubscriptionRow> {
  if (isDevFixtureEnabled()) return NO_ROW
  if (workspaceId === null) return NO_ROW

  try {
    const supabase = await supabaseServer()
    const query = (columns: string) =>
      supabase
        .from('subscriptions')
        .select(columns)
        .eq('workspace_id', workspaceId)
        .maybeSingle<RawSubscription>()

    let { data, error } = await query(FULL_ROW)

    /*
     * THE 42703 RETRY, copied deliberately from loadWorkspacePrefs rather than invented.
     *
     * Code deploys on a push and migrations are applied by hand, so the two always disagree
     * for a window. PostgREST answers a select naming an unknown column with a 400 carrying
     * 42703, and without this branch the blanket catch below would turn that into "you are on
     * Free" for every paying account at once, for as long as the window lasted. The columns
     * are live in production today; the retry is for the next one, and for a fresh database
     * that has run 0024 and not yet 0028.
     */
    if (error !== null && error.code === '42703') {
      const retry = await query(PLAN_ONLY)
      if (retry.error !== null) return UNREADABLE
      return retry.data === null ? NO_ROW : readSubscriptionRow(retry.data, true)
    }

    if (error !== null) return UNREADABLE
    if (data === null) return NO_ROW
    return readSubscriptionRow(data, false)
  } catch {
    // Covers supabaseServer() itself, which throws when the environment is not configured.
    return UNREADABLE
  }
}
