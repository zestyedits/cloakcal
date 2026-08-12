'use client'

/**
 * Turn an RPC failure into something to say to the user.
 *
 * MATCH ON THE SLUG, NOT THE PROSE. The first version of this logic lived in
 * delete-event.tsx and regex-matched the exception's message text, which couples the UI to
 * wording nobody thinks of as an interface: rephrase a `raise exception` for clarity and a
 * user-facing error silently degrades to the raw database message. Every CloakCal RPC now
 * carries a stable slug in the exception's HINT, which PostgREST passes through untouched,
 * and that is what gets matched.
 *
 * The default is deliberately not "Something went wrong". An unrecognised failure is a bug
 * we have not seen, and hiding its text makes it harder to report; showing it is ugly but
 * honest, and matches what the create sheet already does.
 */

/** The subset of a PostgrestError this cares about. Kept structural to avoid the import. */
interface RpcFailure {
  readonly message?: string
  readonly hint?: string | null
  readonly code?: string
}

const BY_SLUG: Record<string, string> = {
  event_not_found: 'This event no longer exists. Reload the page.',
  version_conflict: 'This event changed somewhere else. Refresh to pick up the change, then try again.',
  event_trashed: 'This event was already deleted somewhere else. Reload the page.',

  // Always our bug, never the user's — so the copy promises the one thing they care about
  // (nothing was saved) rather than explaining a cause they cannot act on.
  not_ciphertext: 'Something went wrong securing this event. Nothing was saved.',
  noncanonical_time: 'Something went wrong with the date on this event. Nothing was saved.',
  incomplete_retime: 'Something went wrong with the date on this event. Nothing was saved.',
  inverted_range: 'That would end the event before it starts.',

  // Reachable only by asking to cancel an occurrence that a split already detached. Says
  // where the event went, because "it failed" would leave the user hunting for a row that is
  // still on their calendar and still deletable — just not from here.
  occurrence_detached:
    'This occurrence was edited separately, so it is its own event now. Delete it from there.',
  not_a_series: 'This event does not repeat, so there are no occurrences to remove.',

  retime_recurring_unsupported:
    'Changing when a repeating event happens is not built yet. You can still change its details.',
  all_day_unsupported: 'Editing the timing of an all-day event is not built yet.',

  // Must never read like a partial success. Its entire job is to say the transaction rolled
  // back and the calendar is exactly as it was.
  stored_plan_mismatch: "We couldn't save this safely, so nothing changed. Please try again.",

  // Settings (0018–0020). The not-found family all read the same way on purpose: RLS makes
  // "someone else's" and "nonexistent" deliberately indistinguishable, so the copy is too.
  workspace_not_found: 'This workspace no longer exists. Reload the page.',
  unknown_timezone: 'That does not look like a timezone. Pick one from the list.',
  invalid_week_start: 'That is not a day of the week. Nothing was saved.',
  calendar_not_found: 'This calendar no longer exists. Reload the page.',
  unknown_color: 'That colour is not one of the available options.',
  contact_not_found: 'This contact no longer exists. Reload the page.',
  group_not_found: 'This group no longer exists. Reload the page.',
  cross_workspace: 'That contact belongs to a different workspace.',
  unknown_audience: 'That audience no longer exists. Reload the page.',
  unknown_time_visibility: 'Something went wrong saving this rule. Nothing was saved.',
  rule_not_found: 'This rule was already removed. Reload the page.',

  // create_calendar (0021). The client always seals a name before calling, so a missing
  // one is our bug: the copy promises the thing the user cares about, nothing saved.
  missing_name: 'Something went wrong saving this calendar. Nothing was saved.',
}

export function rpcErrorMessage(error: unknown): string {
  const failure = error as RpcFailure | null

  const slug = failure?.hint ?? undefined
  if (slug != null && slug in BY_SLUG) return BY_SLUG[slug]!

  // RLS refusing the write, rather than the function raising. There is no hint to carry.
  if (failure?.code === '42501') return 'You do not have permission to change this event.'

  if (failure?.message != null && failure.message !== '') return failure.message
  return String(error)
}

/** True when the row moved on underneath us, so the UI can offer a refresh instead of a retry. */
export function isVersionConflict(error: unknown): boolean {
  return (error as RpcFailure | null)?.hint === 'version_conflict'
}
