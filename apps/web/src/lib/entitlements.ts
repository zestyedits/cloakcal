import { type PlanId } from './plans'

/**
 * WHICH PLAN A FEATURE NEEDS. The only map of its kind, and the only answer to "is this
 * allowed" that anything in this product may consult.
 *
 * IT LIVES IN lib/ AND NOT server/, for the reason `lib/settings-sections.ts` states in full:
 * a server component that imports a plain value out of a `'use client'` module gets a
 * client-reference proxy rather than the value, and inside a Suspense fallback that renders
 * as a doubled page rather than as an error. The mirror image applies here. This module is
 * pure data and pure functions, deliberately WITHOUT `server-only`, so a client component
 * that wants to draw a locked state can ask the same question the server asks.
 *
 * THE SPLIT IS ALSO THE HONEST STATEMENT OF WHAT IS ENFORCED WHERE. This file answers "would
 * this plan be allowed", which is a rendering question. `server/entitlements.ts` answers "is
 * this REQUEST allowed", which needs a session and a workspace, and only that one is a gate.
 * Nothing in a browser can be a gate, and putting a `hasEntitlement` call in a client
 * component is drawing a lock, not fitting one.
 *
 * NOTHING SHIPPED IS IN HERE, and that is checked rather than remembered. Every key below is
 * a feature that does not exist: no route serves it, no table stores it, no component draws
 * it. ADR 0007's binding rule is that basic privacy is never paywalled — cloaking, visibility
 * rules and View As are the whole shipped product, so the whole shipped product is free.
 * `entitlements.server.test.ts` intersects these keys against a list of what ships today and
 * fails if the intersection is ever non-empty.
 *
 * WHY THIS IS POPULATED RATHER THAN EMPTY, since "billing gates nothing yet" was the brief.
 * An empty map makes `Feature = never`, which makes `hasEntitlement` a function nothing can
 * call, nothing can test, and nothing can prove correct except by asserting its own emptiness
 * — a test that fails on the day the module starts doing its job. Populated with four unbuilt
 * features it still gates nothing and takes nothing from anybody, while being exercisable
 * today and one line from being load-bearing. See ADR 0009 §7.
 */

/**
 * The four things Pro will add. Identical to `planById('pro').planned`, and a test asserts
 * that rather than trusting it: you cannot gate a feature the pricing page does not disclose.
 */
export type Feature = 'booking' | 'external-sync' | 'shared-calendars' | 'automations'

/**
 * `Record<Feature, PlanId>` is TOTAL, and that totality is the guarantee. Adding a member to
 * the union above stops this object literal compiling, so a new feature cannot arrive without
 * somebody stating which plan it belongs to. A `Partial<>` or an index signature would let a
 * missing entry mean "free" silently, which is the failure mode a feature gate exists to
 * prevent.
 */
export const ENTITLEMENTS: Record<Feature, PlanId> = {
  booking: 'pro',
  'external-sync': 'pro',
  'shared-calendars': 'pro',
  automations: 'pro',
}

/** Every gateable feature, for the sweeps that need to iterate them. */
export const FEATURES = Object.keys(ENTITLEMENTS) as readonly Feature[]

export const isFeature = (value: unknown): value is Feature =>
  typeof value === 'string' && Object.hasOwn(ENTITLEMENTS, value)

/**
 * Would an account on this plan be allowed this feature.
 *
 * AN EXHAUSTIVE SWITCH, NOT A COMPARISON, AND THE DIFFERENCE IS THE WHOLE POINT.
 *
 * This was `return plan === 'pro'` under a comment claiming that a third tier would be "a
 * compile error rather than a silent widening". It would not have been. Adding `'team'` to
 * `PlanId` produced ZERO errors here and `hasEntitlement('team', 'booking')` returned false —
 * denying a paying tier every Pro feature, silently. A comment promising a guarantee the
 * compiler does not give is worse than no comment, because the next reader trusts it and does
 * not look.
 *
 * The `never` branch makes the claim true. A rank function (`rankOf(plan) >= rankOf(required)`)
 * would read as more general and is the wrong shape for the same reason: it is a place for a
 * new tier to acquire capabilities nobody granted it.
 */
export function hasEntitlement(plan: PlanId, feature: Feature): boolean {
  if (ENTITLEMENTS[feature] === 'free') return true

  switch (plan) {
    case 'pro':
      return true
    case 'free':
      return false
    default: {
      const unhandled: never = plan
      throw new Error(`unhandled plan: ${String(unhandled)}`)
    }
  }
}
