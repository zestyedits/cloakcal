import 'server-only'
import { type BillingErrorSlug } from '@/lib/billing-error'
import { supabaseServer } from '@/lib/supabase/server'
import { loadSubscription, type SubscriptionRow } from '../plan'
import { loadWorkspacePrefs } from '../settings'
import { billingConfig, billingEnabled, type BillingConfig } from './config'

/**
 * The preamble every session-authenticated billing route runs, in one place.
 *
 * Three routes need the same six checks in the same order, and the failure mode of writing
 * them three times is not verbosity — it is the third copy quietly missing one. The CSRF pair
 * in particular is the sort of thing that gets added to the route somebody was thinking about
 * and not to its sibling.
 */

export interface BillingRequest {
  readonly config: BillingConfig
  readonly workspaceId: string
  readonly subscription: SubscriptionRow
  readonly origin: string
}

export type BillingFailure = { readonly slug: BillingErrorSlug; readonly status: number }

const fail = (slug: BillingErrorSlug, status: number): BillingFailure => ({ slug, status })

export function isFailure(value: BillingRequest | BillingFailure): value is BillingFailure {
  return 'slug' in value
}

export function billingResponse(failure: BillingFailure): Response {
  // Slug only, never a provider's prose. `lib/billing-error.ts` owns the sentence, on the
  // client, for the same reason `/auth/callback` maps GoTrue's PKCE advice to `link_dead`.
  return Response.json({ error: failure.slug }, { status: failure.status })
}

export async function prepareBillingRequest(
  request: Request,
): Promise<BillingRequest | BillingFailure> {
  /*
   * CSRF, and it is two checks because either alone is thin.
   *
   * A cross-site HTML form can POST to us with the session cookie attached, but it cannot set
   * `content-type: application/json` — the only three values a form may send are
   * form-urlencoded, multipart and text/plain. And the Supabase session cookie is SameSite=Lax,
   * which already blocks a cross-site POST in a current browser. Requiring both means neither
   * assumption has to hold alone.
   */
  if (request.headers.get('content-type')?.includes('application/json') !== true) {
    return fail('bad_request', 400)
  }

  const origin = new URL(request.url).origin
  const sent = request.headers.get('origin')
  if (sent !== null && sent !== origin) return fail('bad_request', 403)

  /*
   * 404 when billing is off, because from the caller's side the feature does not exist. The
   * webhook answers 503 to the same condition, deliberately, because Stripe is a retry loop
   * rather than a caller with an opinion.
   */
  if (!billingEnabled()) return fail('billing_off', 404)
  const config = billingConfig()
  if (config === null) return fail('billing_off', 404)

  // Middleware guards this too, but a route handler must not assume middleware ran. Same rule
  // every server page in this app already follows.
  const supabase = await supabaseServer()
  const { data } = await supabase.auth.getUser()
  if (data.user === null) return fail('not_signed_in', 401)

  // `loadWorkspacePrefs` is THE definition of "which workspace", not a second copy of it.
  const prefs = await loadWorkspacePrefs()
  if (prefs === null) return fail('no_workspace', 409)

  const subscription = await loadSubscription(prefs.workspaceId)
  /*
   * A DEGRADED READ REFUSES TO ACT, and it refuses in both directions. We do not know what
   * this account is on: buying could produce a second subscription and two charges a month,
   * and cancelling could post an id that is not current. `loadPlan` degrading to Free is
   * generous and right for a badge; here it would be a guess with money attached.
   */
  if (subscription.degraded) return fail('provider_unavailable', 503)

  return { config, workspaceId: prefs.workspaceId, subscription, origin }
}

/**
 * Body parsing that cannot throw.
 *
 * A malformed body is a 400, not a 500 landing in an error boundary. Returns an empty object
 * rather than null so callers read fields without a second guard.
 */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json()
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
