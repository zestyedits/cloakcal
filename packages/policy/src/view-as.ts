import { evaluate } from './evaluate.js'
import { redact, type EventPayload, type RedactedEvent } from './redact.js'
import type { Decision, EvaluateInput } from './types.js'

/**
 * View As — the owner previewing what a specific audience sees.
 *
 * Spec §4 calls this a trust feature, not a mocked UI, so it must render through the same
 * authorisation and redaction logic as a real recipient. That is enforced by the contract
 * test, not by convention.
 */
export function previewAs(
  input: EvaluateInput,
  payload: EventPayload,
): { decision: Decision; event: RedactedEvent | null } {
  const decision = evaluate(input)
  return { decision, event: redact(payload, decision) }
}

const label: Record<string, string> = {
  title: 'the title',
  location: 'the location',
  attendees: 'who is attending',
  notes: 'your notes',
  videoLink: 'the meeting link',
  attachments: 'attachments',
}

const readable = (field: string) => label[field] ?? field.replace(/^custom:/, '')

const list = (names: string[]): string =>
  names.length === 1
    ? names[0]!
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`

/**
 * The four-step privacy scale the product renders as chips and preset tiles.
 *
 * Same strings as `PRIVACY_LEVELS` in @cloakcal/ui, declared here independently because
 * this package is deliberately dependency-free — the union is the contract, and a unit
 * test on the UI side keeps the two aligned.
 */
export type DisclosureLevel = 'full' | 'limited' | 'busy' | 'hidden'

/**
 * Collapse a Decision onto the four-step scale.
 *
 * This lives IN the engine because it is an interpretation of a visibility decision, and
 * rule 3 allows exactly one interpreter. A UI that mapped decisions to levels with its own
 * if-chain would be a second implementation that drifts silently.
 *
 * "Limited" is anything between busy and everything: exact time plus some-but-not-all
 * fields — including the degenerate "exact time, no fields", which still discloses more
 * than a busy block does (the precise span, that it recurs, which calendar colours it).
 */
export function decisionToLevel(decision: Decision): DisclosureLevel {
  if (!decision.eventVisible || decision.time === 'hidden') return 'hidden'
  if (decision.time === 'busy') return 'busy'
  const verdicts = Object.values(decision.fields)
  return verdicts.length > 0 && verdicts.every((v) => v === 'visible') ? 'full' : 'limited'
}

/**
 * Plain-language consequence for the privacy UI (spec §2).
 *
 * Phrased from the recipient point of view, because that is the question a user is
 * actually asking — "what will they see?" — not "which rule won". The trace answers the
 * second question, for the audit log.
 */
export function explainDecision(decision: Decision): string {
  if (!decision.eventVisible) return 'They will not see this event at all.'
  if (decision.time === 'busy') return 'They will see that you are busy, and nothing else.'

  const entries = Object.entries(decision.fields)
  const visible = entries.filter(([, v]) => v === 'visible').map(([k]) => readable(k))
  const hidden = entries.filter(([, v]) => v === 'hidden').map(([k]) => readable(k))

  if (visible.length === 0) return 'They will see the time, and no other details.'
  if (hidden.length === 0) return 'They will see the time and every detail.'

  return `They will see the time and ${list(visible)}. ${list(hidden)} stay hidden.`
}
