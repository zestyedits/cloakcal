import {
  decisionToLevel,
  evaluate,
  redactForRecipient,
  type DisclosureLevel,
  type EvaluateInput,
  type EventPayload,
  type RedactedEvent,
  type ViewerIdentity,
  type VisibilityRule,
} from '@cloakcal/policy'
import type { CalendarPage, OccurrenceView } from './events.js'
import { toPolicyFieldName } from './policy-codec.js'

/**
 * Applies the policy engine to a calendar page.
 *
 * Every occurrence leaves the server through redactForRecipient — including the owner's
 * own view. Routing the owner around the engine would mean the most-used path is the one
 * path never exercised by the privacy code, and View As could not be trusted to match it.
 *
 * The engine sees Tier A facts and ciphertext only; it never handles content.
 */

export type AudienceId = 'owner' | `contact:${string}` | `group:${string}` | 'public'

export interface RedactedPage {
  readonly timezone: string
  readonly from: string
  readonly to: string
  readonly audience: AudienceId
  readonly calendars: CalendarPage['calendars']
  readonly occurrences: readonly RedactedOccurrence[]
  /** Occurrences withheld entirely, for the "N hidden" affordance in View As. */
  readonly withheldCount: number
  /**
   * Owner-only: the widest disclosure any non-owner audience gets from the WORKSPACE rules
   * alone, with no event's own rules applied.
   *
   * This is what a privacy chip is measured against. The chip used to show `privacyLevel`
   * unless it was `full`, and `privacyLevel` is the widest disclosure across audiences —
   * which, for an event with no rules of its own, IS this number. One contact set to
   * title-only therefore printed "Limited details" on every row in the calendar: a setting
   * restated once per event rather than a fact about any of them. Rows now show the chip
   * only where they differ from this, the calendar name otherwise, and the UI states this
   * value once per screen so the absence of a chip still has a stated meaning.
   *
   * It does not vary by occurrence — workspace rules do not know which event they are being
   * asked about — so it is computed once per page against a synthetic rule-less event, the
   * same trick `cloak-sheet.tsx` uses to summarise an audience with no event in hand.
   */
  readonly baselineLevel?: DisclosureLevel
}

export interface RedactedOccurrence extends RedactedEvent {
  readonly occurrenceLocal: string
  readonly dst: OccurrenceView['dst']
  /**
   * Present for the owner only, and absent for everybody else.
   *
   * These two exist to let the owner delete their own event: `version` guards the write, and
   * `recurring` lets the confirmation say whether a whole series is about to go. Neither is
   * content, but neither is anyone else's business either — an edit counter is a small side
   * channel, and no other audience has a write for it to guard. Withholding is the default
   * here rather than an afterthought.
   */
  readonly version?: number
  readonly recurring?: boolean
  readonly series?: OccurrenceView['series']
  /**
   * Owner-only, like everything above it: the MOST anyone other than the owner can see of
   * this event — the widest disclosure across every audience that has a rule, plus the
   * public baseline. This is the one-line answer to "how exposed is this event", which is
   * the second line the brand board draws on every block. Computed by the engine
   * (`decisionToLevel` over real evaluations), never by re-reading the rules here.
   */
  readonly privacyLevel?: DisclosureLevel
}

/**
 * Who the engine thinks is looking.
 *
 * `groupIds` is resolved from real membership rather than the hardcoded `['colleagues']` this
 * used to carry. An individual who belongs to no group simply has none, and the engine's
 * group rules then do not apply to them — which is the correct answer and used to be
 * impossible to express.
 */
const viewerFor = (
  audience: AudienceId,
  groupsFor: (contactId: string) => readonly string[],
): ViewerIdentity => {
  if (audience === 'owner') return { kind: 'owner' }
  if (audience === 'public') return { kind: 'public' }
  if (audience.startsWith('group:')) {
    // Previewing a GROUP means previewing a person whose only membership is that group —
    // "what does someone in Clients see". The engine has no `group` viewer kind, and it
    // should not: a group is not a viewer, it is a property of one. Modelling it as a
    // member keeps the tiebreak in D8 doing the same work it does for a real person.
    return { kind: 'individual', contactId: audience, groupIds: [audience.slice('group:'.length)] }
  }
  const contactId = audience.slice('contact:'.length)
  return { kind: 'individual', contactId, groupIds: groupsFor(contactId) }
}

/**
 * Tier A facts in, `EventPayload` out.
 *
 * The field names are TRANSLATED, not cast. This used to read
 * `f.fieldName as EventPayload['fields'][number]['fieldName']`, which silenced the compiler
 * over a real disagreement: the database allowlist spells it `video_link` and the policy
 * engine's union spells it `videoLink`. Redaction decides disclosure with
 * `decision.fields[field.fieldName]`, so a video link would have looked up a key that does
 * not exist, found `undefined`, and been withheld from every audience including the owner —
 * with no error, and no setting that could grant it.
 *
 * The bug was unreachable only because the editor writes three fields today. It failed
 * CLOSED, which is the safe direction and also the quiet one, so it would have shipped.
 *
 * A field this cannot name is dropped rather than passed through. Same reasoning: an unknown
 * name has no defined visibility, and withholding is the only safe answer.
 */
const toPayload = (occurrence: OccurrenceView, timezone: string): EventPayload => ({
  eventId: occurrence.eventId,
  calendarId: occurrence.calendarId,
  start: occurrence.start,
  end: occurrence.end,
  timezone,
  allDay: occurrence.allDay,
  busy: occurrence.busy,
  fields: occurrence.fields.flatMap((f) => {
    const fieldName = toPolicyFieldName(f.fieldName)
    if (fieldName === null) return []
    return [
      {
        fieldName,
        ciphertext: f.ciphertext,
        nonce: f.nonce,
        alg: f.alg,
        keyVersion: f.keyVersion,
      },
    ]
  }),
})

/**
 * Everything the engine needs that is not the calendar itself.
 *
 * Passed in rather than read here, so this module stays pure and the contract test that
 * compares server redaction against client View As can feed both the same inputs.
 */
export interface RedactionContext {
  readonly workspaceId: string
  readonly workspaceRules: readonly VisibilityRule[]
  readonly rulesByEvent: ReadonlyMap<string, readonly VisibilityRule[]>
  /** Group membership per contact, for resolving an individual viewer's group rules. */
  readonly groupsByContact: ReadonlyMap<string, readonly string[]>
  /**
   * What an audience with NO rule sees. Hidden, and it has to be: a calendar that defaulted
   * to visible would disclose everything the moment someone was added as a contact and before
   * anyone decided what they should see.
   */
  readonly defaultTimeVis: 'exact' | 'busy' | 'hidden'
}

/** Widest first, so "the most anyone can see" is a minimum over this ranking. */
const OPENNESS: Record<DisclosureLevel, number> = { full: 0, limited: 1, busy: 2, hidden: 3 }

/**
 * The widest disclosure any of these viewers gets, asked of the real engine each time.
 *
 * Starts at `hidden` and opens: with no viewers at all the answer is that nobody sees
 * anything, which is the correct floor rather than a missing value.
 */
const widestLevel = (
  viewers: Iterable<ViewerIdentity>,
  inputFor: (viewer: ViewerIdentity) => EvaluateInput,
): DisclosureLevel => {
  let widest: DisclosureLevel = 'hidden'
  for (const viewer of viewers) {
    const level = decisionToLevel(evaluate(inputFor(viewer)))
    if (OPENNESS[level] < OPENNESS[widest]) widest = level
  }
  return widest
}

/**
 * The viewers whose sightline the owner's privacy chip summarises: one per audience that
 * a set of rules names, keyed so a contact appearing in several rules is evaluated once.
 * Evaluating only rule-bearing audiences is not a shortcut past the engine — an audience
 * with no rule lands on the hidden default, which cannot widen a maximum that already
 * includes the public baseline.
 */
const collectRuleViewers = (
  rules: readonly VisibilityRule[],
  groupsFor: (contactId: string) => readonly string[],
  into: Map<string, ViewerIdentity>,
): void => {
  for (const rule of rules) {
    if (rule.audience === 'individual' && rule.audienceRef !== null) {
      into.set(`contact:${rule.audienceRef}`, {
        kind: 'individual',
        contactId: rule.audienceRef,
        groupIds: groupsFor(rule.audienceRef),
      })
    } else if (rule.audience === 'group' && rule.audienceRef !== null) {
      // A group is previewed as a person whose only membership is that group — the same
      // modelling viewerFor uses, for the same reason.
      into.set(`group:${rule.audienceRef}`, {
        kind: 'individual',
        contactId: `group:${rule.audienceRef}`,
        groupIds: [rule.audienceRef],
      })
    } else if (rule.audience === 'public') {
      into.set('public', { kind: 'public' })
    }
  }
}

export function redactPage(
  page: CalendarPage,
  audience: AudienceId,
  now: string,
  context: RedactionContext,
): RedactedPage {
  const groupsFor = (id: string) => context.groupsByContact.get(id) ?? []
  const viewer = viewerFor(audience, groupsFor)
  const occurrences: RedactedOccurrence[] = []
  let withheldCount = 0

  // Shared across every occurrence; per-event rules can only add viewers on top.
  const workspaceViewers = new Map<string, ViewerIdentity>()
  collectRuleViewers(context.workspaceRules, groupsFor, workspaceViewers)
  workspaceViewers.set('public', { kind: 'public' })

  /**
   * The workspace baseline: what the widest disclosure is before any event says otherwise.
   *
   * Asked of the engine against a synthetic event carrying no rules, because that is
   * precisely the question — workspace rules do not vary by event, so there is nothing an
   * occurrence could contribute and one evaluation answers it for the whole page. The id is
   * a placeholder that no rule can match, which is what makes the answer rule-less rather
   * than "whatever the first event happened to say".
   */
  const baselineLevel =
    audience === 'owner'
      ? widestLevel(workspaceViewers.values(), (asViewer) => ({
          event: {
            eventId: 'baseline',
            workspaceId: context.workspaceId,
            lifecycle: 'active',
            rules: [],
          },
          viewer: asViewer,
          workspace: {
            workspaceId: context.workspaceId,
            timeVis: context.defaultTimeVis,
            fields: {},
            rules: context.workspaceRules,
          },
          now,
          policyVersion: 'v1',
        }))
      : undefined

  for (const occurrence of page.occurrences) {
    const eventRules = context.rulesByEvent.get(occurrence.eventId) ?? []
    const inputWith =
      (rules: typeof eventRules) =>
      (asViewer: ViewerIdentity): EvaluateInput => ({
        event: {
          eventId: occurrence.eventId,
          workspaceId: context.workspaceId,
          lifecycle: 'active',
          // Per-event overrides. This was always `[]`, so an event-scoped rule could be
          // stored and would never be applied — the engine supported them and nothing fed
          // them in. Passing `[]` deliberately is now how the baseline is asked for.
          rules,
        },
        viewer: asViewer,
        workspace: {
          workspaceId: context.workspaceId,
          timeVis: context.defaultTimeVis,
          fields: {},
          rules: context.workspaceRules,
        },
        now,
        policyVersion: 'v1',
      })
    const inputFor = inputWith(eventRules)

    // The owner's chip: the widest disclosure any non-owner audience gets, each one asked
    // of the real engine. Owner-only work for owner-only metadata — no other audience
    // pays for it or receives it.
    //
    let privacyLevel: DisclosureLevel | undefined
    if (audience === 'owner') {
      const viewers = new Map(workspaceViewers)
      collectRuleViewers(eventRules, groupsFor, viewers)
      privacyLevel = widestLevel(viewers.values(), inputFor)
    }

    const { event } = redactForRecipient(inputFor(viewer), toPayload(occurrence, page.timezone))
    if (event === null) {
      withheldCount += 1
      continue
    }

    occurrences.push({
      ...event,
      occurrenceLocal: occurrence.occurrenceLocal,
      dst: occurrence.dst,
      // Spread last and only for the owner, so a future edit to the engine cannot
      // accidentally start leaking these to an audience by widening `event`.
      ...(audience === 'owner'
        ? {
            version: occurrence.version,
            recurring: occurrence.recurring,
            // A rule and an anchor say WHEN, never what — but "every Tuesday 09:00 until
            // March" is still the shape of somebody's life, and only the owner has a split
            // to plan with it.
            series: occurrence.series,
            ...(privacyLevel === undefined ? {} : { privacyLevel }),
          }
        : {}),
    })
  }

  // A busy block must not disclose which calendar it belongs to, so the calendar list is
  // withheld from any audience that cannot see calendar ids on events.
  //
  // The owner is exempt, and has to be. Deriving disclosure from the occurrences alone
  // meant an owner with an empty week saw no calendars at all — a brand-new account looked
  // like it had failed to create one. There is nothing to protect the owner from here:
  // their calendar list is theirs.
  const disclosesCalendars =
    audience === 'owner' || occurrences.some((o) => o.calendarId !== undefined)

  return {
    timezone: page.timezone,
    from: page.from,
    to: page.to,
    audience,
    calendars: disclosesCalendars ? page.calendars : [],
    occurrences,
    withheldCount,
    ...(baselineLevel === undefined ? {} : { baselineLevel }),
  }
}
