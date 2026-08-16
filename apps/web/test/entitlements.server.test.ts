import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ENTITLEMENTS,
  FEATURES,
  hasEntitlement,
  isFeature,
  type Feature,
} from '../src/lib/entitlements'
import { PLANS, planById, type PlanId } from '../src/lib/plans'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

describe('the entitlement map', () => {
  it('covers every feature and names a real plan for each', () => {
    expect(FEATURES.length).toBeGreaterThan(0)
    expect(new Set(FEATURES)).toEqual(new Set(Object.keys(ENTITLEMENTS)))

    const known = new Set<string>(PLANS.map((plan) => plan.id))
    for (const feature of FEATURES) {
      expect(known, `${feature} requires a plan that exists`).toContain(ENTITLEMENTS[feature])
    }
  })

  it('grants a Pro feature to Pro and refuses it to Free', () => {
    for (const feature of FEATURES) {
      expect(hasEntitlement('pro', feature), `pro should have ${feature}`).toBe(true)
      expect(hasEntitlement('free', feature), `free should not have ${feature}`).toBe(false)
    }
  })

  it('recognises its own keys and nothing else', () => {
    for (const feature of FEATURES) expect(isFeature(feature)).toBe(true)
    // `toString` and `constructor` are the interesting ones: a plain `in` check or a bare
    // property read would say yes to both, which is how a prototype key becomes a feature.
    for (const value of ['booking ', 'BOOKING', 'toString', 'constructor', '', 42, null]) {
      expect(isFeature(value), `${String(value)} is not a feature`).toBe(false)
    }
  })

  /**
   * YOU CANNOT GATE A FEATURE THE PRICING PAGE DOES NOT DISCLOSE.
   *
   * `/settings/plan` renders `planById('pro').planned` as "What Pro will add". A key here
   * with no row there would be a capability that costs money and is advertised nowhere, which
   * is the shape of thing a reviewer finds rather than a user.
   */
  it('gates nothing that Pro does not publicly list', () => {
    const published = planById('pro').planned.map((item) => item.name.toLowerCase())
    const listed = (needle: string) => published.some((name) => name.includes(needle))

    // The map's keys and the catalog's prose are written for different readers, so this maps
    // one to the other explicitly rather than slugifying and hoping the two agree.
    const DISCLOSED: Record<Feature, string> = {
      booking: 'booking',
      'external-sync': 'other calendars',
      'shared-calendars': 'shared calendars',
      automations: 'automations',
    }

    for (const feature of FEATURES) {
      expect(
        listed(DISCLOSED[feature]),
        `${feature} must appear in Pro's planned list`,
      ).toBe(true)
    }
  })

  /**
   * ADR 0007's BINDING RULE, MADE MECHANICAL: basic privacy is never paywalled. Cloaking,
   * visibility rules and View As are effectively the whole shipped product, so the whole
   * shipped product is free, and this test is what stops that depending on whoever is
   * reading. If one of these ever needs to move behind Pro, the argument happens in an ADR
   * and this list changes in the same commit — deliberately more friction than editing a map.
   */
  it('gates nothing that already ships', () => {
    const SHIPPED = [
      'cloaking',
      'visibility-rules',
      'view-as',
      'calendars',
      'contacts',
      'groups',
      'recurrence',
      'availability',
      'holidays',
      'export',
      'passkeys',
      'recovery-phrase',
      'password-change',
      'keyboard-shortcuts',
      'themes',
      'agenda-view',
      'week-view',
      'day-view',
      'month-view',
    ]

    const gated = new Set<string>(FEATURES)
    const overlap = SHIPPED.filter((feature) => gated.has(feature))
    expect(overlap, 'a shipped feature may not move behind Pro').toEqual([])
  })

  /**
   * The map is total by type, and this is the runtime half of the same claim: every plan a
   * feature can require must be one the catalog knows how to render.
   */
  it('never requires a plan the catalog cannot price', () => {
    for (const feature of FEATURES) {
      const required: PlanId = ENTITLEMENTS[feature]
      expect(() => planById(required)).not.toThrow()
    }
  })
})

/**
 * EVERY ROUTE HANDLER EITHER GATES OR SAYS WHY IT DOES NOT.
 *
 * A handler that forgets `requireEntitlement` compiles perfectly and serves a paid feature to
 * everybody, and no type system here will change that cheaply. This repo's answer to that
 * class of problem is a source sweep — `auth-buttons.server.test.ts`, `plan-badge`'s
 * subscription grep, `security-posture.test.ts` — so this is one more.
 *
 * The allowlist is the useful part. Billing's own routes are ungated by construction: you
 * cannot require Pro in order to buy Pro. Adding a route to it becomes an edit somebody has
 * to justify in a diff, rather than an omission nobody sees.
 */
const UNGATED: Record<string, string> = {
  'app/auth/callback/route.ts': 'Redeems an emailed sign-in link. Predates any plan.',

  // Billing's own four are ungated BY CONSTRUCTION, and saying so here is the point of the
  // allowlist: each line is a claim somebody had to write in a diff rather than an omission
  // nobody noticed. All four must work for an account on its way INTO or OUT OF Pro.
  'app/api/billing/checkout/route.ts':
    'Sells Pro. Requiring Pro in order to buy Pro is a locked door with the key inside.',
  'app/api/billing/subscription/route.ts':
    'Cancel, resume and switch cadence. Gating cancel on the plan being cancelled would trap ' +
    'a lapsing account, and gating it on Pro would break the moment Stripe marks it past_due.',
  'app/api/billing/portal/route.ts':
    'Updating a card, including for an account that has lapsed to Free and wants to fix the ' +
    'card that failed.',
  'app/api/billing/webhook/route.ts':
    'Stripe has no session and no plan. Authenticated by signature, and it is the thing that ' +
    'WRITES the entitlement, so it cannot depend on one.',
}

function routeHandlers(dir: string, prefix = ''): string[] {
  let found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const rel = prefix === '' ? entry : `${prefix}/${entry}`
    if (statSync(full).isDirectory()) found = found.concat(routeHandlers(full, rel))
    else if (entry === 'route.ts') found.push(rel)
  }
  return found
}

describe('route handlers', () => {
  const handlers = routeHandlers(join(SRC, 'app'), 'app')

  it('finds the route handlers at all, so this sweep cannot pass vacuously', () => {
    expect(handlers.length).toBeGreaterThan(0)
    expect(handlers).toContain('app/auth/callback/route.ts')
  })

  it('either calls requireEntitlement or is listed with a reason', () => {
    for (const handler of handlers) {
      const source = readFileSync(join(SRC, handler), 'utf8')
      const gates = source.includes('requireEntitlement(')
      const excused = Object.hasOwn(UNGATED, handler)
      expect(
        gates || excused,
        `${handler} serves a request without an entitlement check and is not in UNGATED`,
      ).toBe(true)
    }
  })

  it('has no stale allowlist entries', () => {
    for (const listed of Object.keys(UNGATED)) {
      expect(handlers, `${listed} is allowlisted but no longer exists`).toContain(listed)
    }
  })
})
