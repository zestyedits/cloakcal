import { evaluate } from './evaluate.js'
import { redact, type EventPayload, type RedactedEvent } from './redact.js'
import type { Decision, EvaluateInput } from './types.js'

/**
 * The server entry point: what a recipient API response contains.
 *
 * A separate named export from `previewAs`, even though the bodies are identical today.
 * The contract test asserts the two agree across every vector — so if a future change
 * optimises one path (a cache, a fast path for public viewers, a shortcut that skips the
 * engine), the divergence surfaces immediately instead of becoming a privacy bug nobody
 * notices until a recipient sees something the owner was shown they would not.
 */
export function redactForRecipient(
  input: EvaluateInput,
  payload: EventPayload,
): { decision: Decision; event: RedactedEvent | null } {
  const decision = evaluate(input)
  return { decision, event: redact(payload, decision) }
}
