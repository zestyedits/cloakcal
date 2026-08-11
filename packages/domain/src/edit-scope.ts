import { Temporal } from '@js-temporal/polyfill'
import { RRule } from 'rrule'
import { countOccurrencesBefore } from './recurrence.js'
import type { ExceptionSpec, SeriesSpec } from './recurrence.js'

/**
 * Recurrence edit scopes (spec §3): **this event**, **this and future**, **entire series**.
 *
 * These are pure planners. They take the current series and the occurrence being edited,
 * and return a description of the writes to perform — they do not touch the database. That
 * keeps the hard part (what should happen) independently testable from the easy part
 * (issuing the writes), and it means the same plan can be replayed by the offline outbox
 * at M4 without re-deriving it.
 *
 * Every scope is expressed against the ORIGINAL LOCAL occurrence, never an instant, for
 * the reason in ADR 0001: an instant key moves under a DST transition.
 */

export type EditScope = 'this' | 'this-and-future' | 'entire-series'

export interface SeriesEditPlan {
  readonly scope: EditScope
  /** Exception rows to insert against the existing series. */
  readonly exceptions: readonly ExceptionSpec[]
  /** Replacement RRULE for the existing series, or null to leave it unchanged. */
  readonly truncateSeriesTo: string | null
  /** A brand-new series to create, or null. Used by `this-and-future`. */
  readonly newSeries: SeriesSpec | null
  /** A single detached event to create, or null. Used by `this`. */
  readonly detachedOccurrence: { readonly occurrenceLocal: string } | null
  /** Plain-language summary for the confirmation UI. */
  readonly summary: string
}

/**
 * UNTIL carries floating local wall-clock fields, matching how DTSTART is stored.
 *
 * The trailing `Z` is a serialization artifact, NOT a claim about UTC. Expansion runs
 * entirely in rrule's floating convention, where local wall-clock fields are carried in a
 * Date's UTC fields (see recurrence.ts) — so UNTIL must use the same convention or the two
 * ends of the rule would disagree. rrule also requires the `Z` form to parse UNTIL at all.
 *
 * Mixing a genuinely-UTC UNTIL into a floating expansion is how a series quietly ends an
 * hour early twice a year. Conversion to an RFC-compliant UTC UNTIL happens at the
 * export/sync boundary, which is the only place it is needed.
 */
const formatUntilLocal = (local: Temporal.PlainDateTime): string =>
  [
    String(local.year).padStart(4, '0'),
    String(local.month).padStart(2, '0'),
    String(local.day).padStart(2, '0'),
    'T',
    String(local.hour).padStart(2, '0'),
    String(local.minute).padStart(2, '0'),
    String(local.second).padStart(2, '0'),
    'Z',
  ].join('')

export class ImpossibleSplitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImpossibleSplitError'
  }
}

/**
 * Carry a bounded series' remaining COUNT onto the successor.
 *
 * THE BUG THIS FIXES. `truncateRrule` correctly strips COUNT from the truncated series
 * (UNTIL replaces it), but the successor used to inherit `series.rrule` verbatim — COUNT and
 * all. `FREQ=WEEKLY;COUNT=10` split at the 4th occurrence produced 3 + 10 = 13 occurrences,
 * silently manufacturing three meetings that were never scheduled. A windowed verification
 * misses it whenever the window ends before the phantom tail.
 *
 * Unbounded rules pass through untouched: there is no budget to divide.
 */
function rewriteSuccessorCount(rrule: string, consumed: number): string {
  const parts = rrule.split(';').map((p) => p.trim()).filter((p) => p.length > 0)
  const index = parts.findIndex((p) => /^count=/i.test(p))
  if (index === -1) return parts.join(';')

  const total = Number(parts[index]!.slice('count='.length))
  const remaining = total - consumed

  if (!Number.isInteger(total) || total < 1) {
    throw new ImpossibleSplitError(`Series has an unusable COUNT: ${parts[index]}`)
  }
  if (remaining < 1) {
    // The split point is at or past the end of a bounded series, so the successor would own
    // nothing. COUNT=0 is not expressible in RFC 5545, and inventing an occurrence to keep
    // the rule valid would be worse than refusing: it would add a meeting nobody scheduled.
    throw new ImpossibleSplitError(
      `Splitting here leaves the new series empty: all ${total} occurrences fall before the split point`,
    )
  }

  parts[index] = `COUNT=${remaining}`
  return parts.join(';')
}

/** Replace or append UNTIL, and drop COUNT — the two are mutually exclusive in RFC 5545. */
export function truncateRrule(rrule: string, untilLocal: Temporal.PlainDateTime): string {
  const parts = rrule
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !/^until=/i.test(p) && !/^count=/i.test(p))

  parts.push(`UNTIL=${formatUntilLocal(untilLocal)}`)
  return parts.join(';')
}

export interface PlanInput {
  readonly series: SeriesSpec
  /** The occurrence the user acted on, as its original local wall time. */
  readonly occurrenceLocal: string
  readonly scope: EditScope
}

export function planSeriesEdit(input: PlanInput): SeriesEditPlan {
  const { series, occurrenceLocal, scope } = input

  if (series.rrule === null) {
    // A single event has no scopes to choose between; treating it as `entire-series` keeps
    // callers from having to special-case it, and the summary stays truthful.
    return {
      scope: 'entire-series',
      exceptions: [],
      truncateSeriesTo: null,
      newSeries: null,
      detachedOccurrence: null,
      summary: 'This event will be updated.',
    }
  }

  const occurrence = Temporal.PlainDateTime.from(occurrenceLocal)

  switch (scope) {
    case 'this':
      // Detach one occurrence: mark it moved in the series, create a standalone event.
      // `moved` rather than `cancelled` so history distinguishes "I edited that one" from
      // "I deleted that one" — the audit log and the UI read differently for each.
      return {
        scope,
        exceptions: [{ occurrenceLocal, kind: 'moved' }],
        truncateSeriesTo: null,
        newSeries: null,
        detachedOccurrence: { occurrenceLocal },
        summary: 'Only this occurrence will change. The rest of the series stays as it is.',
      }

    case 'this-and-future': {
      // End the existing series just before this occurrence, then start a new one here.
      // Splitting rather than editing in place preserves history: past occurrences keep
      // their original definition, which matters for the audit trail and for anyone who
      // already saw them.
      // One second before the split occurrence. UNTIL is inclusive in RFC 5545, so using
      // the occurrence itself would leave it in BOTH the truncated series and the new one.
      const until = occurrence.subtract({ seconds: 1 })
      return {
        scope,
        exceptions: [],
        truncateSeriesTo: truncateRrule(series.rrule, until),
        newSeries: {
          dtstartLocal: occurrenceLocal,
          durationMinutes: series.durationMinutes,
          timezone: series.timezone,
          // NOT `series.rrule` verbatim. A bounded series has to divide its COUNT budget
          // between the two halves, or the split conjures occurrences out of nothing.
          rrule: rewriteSuccessorCount(
            series.rrule,
            countOccurrencesBefore(series, occurrenceLocal),
          ),
        },
        detachedOccurrence: null,
        summary:
          'This occurrence and every one after it will change. Earlier occurrences stay as they are.',
      }
    }

    case 'entire-series':
      return {
        scope,
        exceptions: [],
        truncateSeriesTo: null,
        newSeries: null,
        detachedOccurrence: null,
        summary: 'Every occurrence will change, including ones that have already happened.',
      }
  }
}

/** Deleting one occurrence is a cancellation, not a move. */
export function planOccurrenceDelete(occurrenceLocal: string): ExceptionSpec {
  return { occurrenceLocal, kind: 'cancelled' }
}

/**
 * Validate an RRULE before it is stored. rrule accepts a good deal of nonsense silently,
 * and an unparseable rule discovered at render time means a calendar that will not draw.
 */
export function isValidRrule(rrule: string): boolean {
  try {
    const options = RRule.parseString(rrule)
    if (options.freq === undefined) return false
    new RRule({ ...options, dtstart: new Date(Date.UTC(2026, 0, 1)) })
    return true
  } catch {
    return false
  }
}
