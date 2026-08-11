import {
  expandSeries,
  planSeriesEdit,
  type EditScope,
  type ExceptionSpec,
  type SeriesSpec,
} from '@cloakcal/domain'

/**
 * Planning a series split, and proving the plan is safe before anything is written.
 *
 * THIS IS HALF OF A GUARANTEE. The reference implementation in packages/db re-expands the
 * STORED series after writing and compares the occurrence set. `split_cloaked_event` cannot:
 * expanding an RRULE needs a full RFC 5545 engine, Postgres has none, and hand-rolling a
 * second one in plpgsql would give the codebase two recurrence implementations that disagree
 * on a DST boundary — the exact thing ADR 0001 exists to prevent.
 *
 * So it is decomposed:
 *
 *   3a — here, before the call: the PLAN is lossless, checked with the one recurrence engine.
 *   3b — in SQL, inside the transaction: what was STORED is byte-for-byte the plan.
 *
 * Together they give expand(stored) == expand(original), because expansion is deterministic
 * in exactly the four values 3b compares: dtstart_local, timezone, rrule, and duration.
 * Neither half means much alone — 3a without 3b proves something about a plan that may not
 * have survived the trip, and 3b without 3a proves the database faithfully stored a bad idea.
 *
 * This module is deliberately pure and importable from a test: it does no I/O and holds no
 * key material.
 */

export class UnsafeSplitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeSplitError'
  }
}

export interface SplitTiming {
  /** New wall-clock anchor for the detached occurrence or the successor series. */
  readonly dtstartLocal: string
  readonly startUtc: string
  readonly endUtc: string
}

export interface SplitPlan {
  readonly scope: Exclude<EditScope, 'entire-series'>
  readonly newEventId: string
  /** Replacement rule for the original. Null for `this`, which truncates nothing. */
  readonly truncateRrule: string | null
  readonly newDtstartLocal: string
  readonly newStartUtc: string
  readonly newEndUtc: string
  /** The successor's rule. Null for `this`, which detaches a single non-repeating event. */
  readonly newRrule: string | null
  /** Plain-language consequence, for the confirmation UI. */
  readonly summary: string
}

/**
 * The window losslessness is checked over.
 *
 * A year either side of the split. Wide enough that a rule with a yearly or monthly period
 * contributes occurrences on both sides — a window that only straddled by a few days would
 * make the comparison vacuous for anything but a daily or weekly series, and a vacuous check
 * passes while proving nothing.
 */
const verifyWindow = (occurrenceLocal: string) => {
  const year = Number(occurrenceLocal.slice(0, 4))
  return { from: `${year - 1}-01-01T00:00:00Z`, to: `${year + 2}-01-01T00:00:00Z` }
}

export function planSplit(input: {
  readonly series: SeriesSpec
  readonly occurrenceLocal: string
  readonly scope: Exclude<EditScope, 'entire-series'>
  readonly newEventId: string
  readonly exceptions?: readonly ExceptionSpec[]
  /** Present only when the user is also moving the event. */
  readonly timing?: SplitTiming
}): SplitPlan {
  const { series, occurrenceLocal, scope, newEventId, timing } = input
  const exceptions = input.exceptions ?? []

  if (series.rrule === null) {
    throw new UnsafeSplitError('This event does not repeat, so there is nothing to split.')
  }

  const plan = planSeriesEdit({ series, occurrenceLocal, scope })

  const newRrule = scope === 'this-and-future' ? (plan.newSeries?.rrule ?? null) : null
  const truncateRrule = plan.truncateSeriesTo

  const timings: SplitTiming = timing ?? {
    dtstartLocal: occurrenceLocal,
    ...instantsFor(series, occurrenceLocal),
  }

  verifySplit({
    series,
    exceptions,
    occurrenceLocal,
    scope,
    truncateRrule,
    successor:
      scope === 'this-and-future'
        ? { ...series, dtstartLocal: timings.dtstartLocal, rrule: newRrule }
        : null,
    retimed: timing !== undefined,
  })

  return {
    scope,
    newEventId,
    truncateRrule,
    newDtstartLocal: timings.dtstartLocal,
    newStartUtc: timings.startUtc,
    newEndUtc: timings.endUtc,
    newRrule,
    summary: plan.summary,
  }
}

/** Resolve one occurrence of the series to the instants the new row will store. */
function instantsFor(series: SeriesSpec, occurrenceLocal: string): Omit<SplitTiming, 'dtstartLocal'> {
  const [occurrence] = expandSeries(
    { ...series, rrule: null, dtstartLocal: occurrenceLocal },
    { from: '1970-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' },
  )
  if (occurrence === undefined) {
    throw new UnsafeSplitError('That occurrence could not be resolved to a time.')
  }
  return { startUtc: occurrence.startInstant, endUtc: instantAfter(occurrence.startInstant, series.durationMinutes) }
}

const instantAfter = (instant: string, minutes: number): string =>
  new Date(new Date(instant).getTime() + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z')

/**
 * Gate 3a. Throws rather than returning a boolean, because a caller that forgot to check a
 * boolean would write the split anyway — and this is the only edit that can destroy
 * occurrences.
 */
function verifySplit(input: {
  series: SeriesSpec
  exceptions: readonly ExceptionSpec[]
  occurrenceLocal: string
  scope: Exclude<EditScope, 'entire-series'>
  truncateRrule: string | null
  successor: SeriesSpec | null
  retimed: boolean
}): void {
  const { series, exceptions, occurrenceLocal, scope, truncateRrule, successor, retimed } = input
  const range = verifyWindow(occurrenceLocal)

  const original = expandSeries(series, range, exceptions).map((o) => o.occurrenceLocal)
  const past = original.filter((o) => o < occurrenceLocal)

  if (scope === 'this') {
    // Detaching removes the occurrence from the series and re-adds it as its own row, so the
    // series must lose exactly that one and nothing else.
    const after = expandSeries(series, range, [
      ...exceptions,
      { occurrenceLocal, kind: 'moved' },
    ]).map((o) => o.occurrenceLocal)

    const lost = original.filter((o) => !after.includes(o))
    if (lost.length !== 1 || lost[0] !== occurrenceLocal) {
      throw new UnsafeSplitError(
        `Detaching this occurrence would change ${lost.length} occurrences, not one.`,
      )
    }
    return
  }

  if (truncateRrule === null || successor === null) {
    throw new UnsafeSplitError('This split has no successor series, so it would lose occurrences.')
  }

  const truncated = expandSeries({ ...series, rrule: truncateRrule }, range, exceptions).map(
    (o) => o.occurrenceLocal,
  )

  // ALWAYS true, retimed or not: the past is not ours to edit. This is the check that
  // catches an off-by-one in UNTIL, which is the classic way a split eats the occurrence the
  // user was standing on.
  if (truncated.join('|') !== past.join('|')) {
    throw new UnsafeSplitError(
      'That change would alter occurrences before this one. Nothing was saved.',
    )
  }

  const kept = expandSeries(successor, range, exceptions).map((o) => o.occurrenceLocal)
  if (kept.length === 0) {
    throw new UnsafeSplitError('That change would leave no occurrences after this one.')
  }

  if (retimed) {
    // The successor deliberately lands on different wall times, so the occurrence SET cannot
    // match. Two weaker invariants replace it.

    // 1. The new series actually STARTS where the user put it. This is the one that catches
    //    an anchor fighting its own rule: move a `BYDAY=TU` series to a Wednesday and rrule
    //    keeps generating Tuesdays, so the event silently lands on a different day from the
    //    one just picked. A count check cannot see that — the number of occurrences is
    //    unchanged, only the dates are wrong — which is why it is checked separately.
    if (kept[0] !== successor.dtstartLocal) {
      throw new UnsafeSplitError(
        `This event repeats on a fixed weekday, so it cannot move to ${successor.dtstartLocal.slice(0, 10)}. ` +
          `The next occurrence would be ${kept[0]?.slice(0, 10) ?? 'never'}.`,
      )
    }

    // 2. The same number survives. A retime is a move, not a deletion.
    const future = original.filter((o) => o >= occurrenceLocal)
    if (kept.length !== future.length) {
      throw new UnsafeSplitError(
        `That change would turn ${future.length} occurrences into ${kept.length}.`,
      )
    }
    return
  }

  // Content-only: the split must be invisible in the calendar.
  const rejoined = [...truncated, ...kept]
  if (rejoined.join('|') !== original.join('|')) {
    throw new UnsafeSplitError('That change would add or lose occurrences. Nothing was saved.')
  }
  if (new Set(rejoined).size !== rejoined.length) {
    throw new UnsafeSplitError('That change would show some occurrences twice.')
  }
}
