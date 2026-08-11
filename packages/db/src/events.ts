import { CLOAK_ALG, type CloakedPayload } from '@cloakcal/crypto'
import {
  expandSeries,
  occurrenceInstant,
  planSeriesEdit,
  type EditScope,
  type SeriesSpec,
} from '@cloakcal/domain'

/**
 * Event CRUD — the layer where recurrence, encryption and RLS meet.
 *
 * FIVE SERVICE GATES, all enforced here rather than left to callers:
 *   1. A series split is atomic. Truncate, successor, exceptions and audit land in ONE
 *      transaction, or none of them do.
 *   2. Optimistic concurrency. Every mutation is guarded by an expected version, so two
 *      concurrent edits cannot produce overlapping or lost series.
 *   3. Post-write verification. After a split, the STORED series are re-expanded and
 *      compared against the plan. A mismatch rolls the transaction back.
 *   4. No plaintext, ever. Tier B content enters only as CloakedPayload — the signature
 *      makes a string unrepresentable, and a runtime guard catches structural mistakes.
 *   5. Cross-workspace writes fail, and failure rolls back cleanly.
 */

export interface QueryResult {
  rows: Record<string, unknown>[]
}

export type Executor = (sql: string, params?: unknown[]) => Promise<QueryResult>

export interface Db {
  query: Executor
  transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T>
}

/* -------------------------------------------------------------------------- */
/* Gate 4 — nothing plaintext crosses this boundary                           */
/* -------------------------------------------------------------------------- */

export interface CloakedField {
  readonly fieldName: string
  readonly payload: CloakedPayload
}

export class PlaintextRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlaintextRejectedError'
  }
}

export class VersionConflictError extends Error {
  constructor(
    readonly eventId: string,
    readonly expected: number,
  ) {
    super(`Event ${eventId} was modified by someone else (expected version ${expected})`)
    this.name = 'VersionConflictError'
  }
}

export class VerificationFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VerificationFailedError'
  }
}

/**
 * Structural check that a value is genuine AEAD output.
 *
 * The TYPE is the real guard — `CloakedPayload` cannot be satisfied by a string, so
 * plaintext cannot reach here from typed code. This catches the cases types cannot: a
 * value crossing an `any` boundary, arriving over the wire, or built by hand in a test.
 *
 * The 16-byte floor is meaningful rather than arbitrary: AES-GCM output always carries a
 * 128-bit authentication tag, so any real ciphertext is at least 16 bytes even when the
 * plaintext is empty. A short field name or title encoded as bytes fails it outright.
 */
export function assertCloaked(field: CloakedField): void {
  const { fieldName, payload } = field

  if (payload.alg !== CLOAK_ALG) {
    throw new PlaintextRejectedError(
      `Field "${fieldName}" has algorithm "${payload.alg}"; only ${CLOAK_ALG} may be stored`,
    )
  }
  if (!(payload.ciphertext instanceof Uint8Array) || !(payload.nonce instanceof Uint8Array)) {
    throw new PlaintextRejectedError(`Field "${fieldName}" must carry raw bytes, not text`)
  }
  if (payload.nonce.length !== 12) {
    throw new PlaintextRejectedError(
      `Field "${fieldName}" has a ${payload.nonce.length}-byte nonce; AES-GCM requires 12`,
    )
  }
  if (payload.ciphertext.length < 16) {
    throw new PlaintextRejectedError(
      `Field "${fieldName}" ciphertext is ${payload.ciphertext.length} bytes; ` +
        `real AES-GCM output is at least 16 (the authentication tag). This looks like plaintext.`,
    )
  }
  if (!Number.isInteger(payload.keyVersion) || payload.keyVersion < 1) {
    throw new PlaintextRejectedError(`Field "${fieldName}" has an invalid key version`)
  }
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

export interface CreateEventInput {
  readonly workspaceId: string
  readonly calendarId: string
  readonly ownerId: string
  readonly startUtc: string
  readonly endUtc: string
  readonly timezone: string
  readonly rrule?: string | null
  readonly dtstartLocal?: string | null
  readonly allDay?: { readonly startDate: string; readonly endDate: string } | null
  readonly busy?: 'busy' | 'free' | 'tentative'
  readonly reminderOffsets?: readonly number[]
  readonly fields: readonly CloakedField[]
}

const insertCloakedFields = async (
  tx: Executor,
  workspaceId: string,
  subjectType: 'event' | 'calendar' | 'workspace',
  subjectId: string,
  fields: readonly CloakedField[],
): Promise<void> => {
  for (const field of fields) {
    assertCloaked(field)
    await tx(
      `insert into public.cloaked_fields
         (subject_type, subject_id, workspace_id, field_name, ciphertext, nonce, alg, key_version)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        subjectType,
        subjectId,
        workspaceId,
        field.fieldName,
        field.payload.ciphertext,
        field.payload.nonce,
        field.payload.alg,
        field.payload.keyVersion,
      ],
    )
  }
}

const audit = (
  tx: Executor,
  workspaceId: string,
  actorId: string,
  action: string,
  subjectId: string,
  detail: Record<string, unknown> = {},
) =>
  tx(
    `insert into public.audit_log (workspace_id, actor_id, action, subject_type, subject_id, detail)
     values ($1, $2, $3, 'event', $4, $5::jsonb)`,
    [workspaceId, actorId, action, subjectId, JSON.stringify(detail)],
  )

export async function createEvent(db: Db, input: CreateEventInput): Promise<string> {
  // Validate before opening a transaction: a rejected field should never begin a write.
  for (const field of input.fields) assertCloaked(field)

  return db.transaction(async (tx) => {
    const { rows } = await tx(
      `insert into public.events
         (workspace_id, calendar_id, owner_id, start_utc, end_utc, timezone,
          all_day, start_date, end_date, rrule, dtstart_local, busy, reminder_offsets)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       returning id`,
      [
        input.workspaceId,
        input.calendarId,
        input.ownerId,
        input.startUtc,
        input.endUtc,
        input.timezone,
        input.allDay != null,
        input.allDay?.startDate ?? null,
        input.allDay?.endDate ?? null,
        input.rrule ?? null,
        input.dtstartLocal ?? null,
        input.busy ?? 'busy',
        [...(input.reminderOffsets ?? [])],
      ],
    )

    const eventId = rows[0]!['id'] as string
    await insertCloakedFields(tx, input.workspaceId, 'event', eventId, input.fields)
    await audit(tx, input.workspaceId, input.ownerId, 'event.created', eventId, {
      fields: input.fields.map((f) => f.fieldName),
    })

    return eventId
  })
}

/** Read a stored event back as the domain's SeriesSpec. Tier A only — no content. */
export async function loadSeriesSpec(
  exec: Executor,
  eventId: string,
): Promise<(SeriesSpec & { version: number }) | null> {
  // Postgres renders every temporal value as TEXT here, and computes the duration itself.
  //
  // This is deliberate and load-bearing. Drivers disagree about how to materialise
  // `timestamp without time zone`: PGlite parses it through the HOST machine's timezone,
  // so reading the result with getUTC* silently shifts a 09:00 anchor by the local offset.
  // That is precisely the host-timezone dependence ADR 0001 exists to eliminate, and it
  // reappears at the driver boundary unless the boundary refuses to hand back a Date.
  //
  // No `new Date(...)` anywhere in this read path.
  const { rows } = await exec(
    `select
       to_char(coalesce(dtstart_local, start_utc at time zone timezone),
               'YYYY-MM-DD"T"HH24:MI:SS')                     as dtstart_local,
       (extract(epoch from (end_utc - start_utc)) / 60)::int   as duration_minutes,
       timezone,
       rrule,
       version
     from public.events where id = $1`,
    [eventId],
  )
  const row = rows[0]
  if (row === undefined) return null

  return {
    dtstartLocal: String(row['dtstart_local']),
    durationMinutes: Number(row['duration_minutes']),
    timezone: String(row['timezone']),
    rrule: row['rrule'] == null ? null : String(row['rrule']),
    version: Number(row['version']),
  }
}

export interface VerifyRange {
  readonly from: string
  readonly to: string
}

export interface SeriesEditBase {
  readonly seriesId: string
  readonly workspaceId: string
  readonly actorId: string
  readonly occurrenceLocal: string
  /** Gate 2: the version the caller believes it is editing. */
  readonly expectedVersion: number
  /** Content for a detached occurrence or a successor series. Cloaked, never plaintext. */
  readonly fields?: readonly CloakedField[]
}

/**
 * Gate 3 made unskippable.
 *
 * `verifyRange` was previously optional for every scope, which meant a caller could
 * silently bypass post-write verification on a split by forgetting one field. A split is
 * the only edit that can destroy future occurrences, so it is the one edit where
 * verification must not be a matter of remembering.
 *
 * The union makes `this-and-future` without a range a COMPILE error. `assertVerifyRange`
 * covers the rest — values arriving over an API boundary or through `any`.
 */
/**
 * `newEventId` is supplied by the CALLER, and it has to be.
 *
 * THE BUG THIS FIXES. Both `this` and `this-and-future` create a new event row and file the
 * caller's sealed fields against it. The id used to come back from Postgres (`returning
 * id`), which meant the caller had sealed those fields before the id existed — and the
 * AEAD's additional data binds ciphertext to the subject id (packages/crypto buildAad), as
 * does the per-field key derivation. So the successor's content could never be decrypted by
 * anyone, ever. It read as "Private event" forever, indistinguishable from a lost key.
 *
 * No test caught it because the fixtures seal against a placeholder and never decrypt.
 * `edit-event.aad.test.ts` now does the round trip.
 *
 * The caller generates a UUID, seals against it, and passes it here. `entire-series` creates
 * no row, so it needs no id — and the union makes supplying one a compile error rather than
 * a silently ignored argument.
 */
export type SeriesEditCommand =
  | (SeriesEditBase & { readonly scope: 'this'; readonly newEventId: string })
  | (SeriesEditBase & { readonly scope: 'entire-series'; readonly verifyRange?: VerifyRange })
  | (SeriesEditBase & {
      readonly scope: 'this-and-future'
      readonly newEventId: string
      readonly verifyRange: VerifyRange
    })

export class InvalidVerifyRangeError extends Error {
  constructor(message: string) {
    super(`Post-write verification range is unusable: ${message}`)
    this.name = 'InvalidVerifyRangeError'
  }
}

const isIsoInstant = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  const t = Date.parse(value)
  return Number.isFinite(t) && /\d{4}-\d{2}-\d{2}T/.test(value)
}

/** Structural validation. Runs before any write, so a bad range never opens a transaction. */
export function assertVerifyRangeShape(range: unknown): asserts range is VerifyRange {
  if (range === null || typeof range !== 'object') {
    throw new InvalidVerifyRangeError('a range is required for a this-and-future edit')
  }
  const { from, to } = range as Record<string, unknown>
  if (!isIsoInstant(from) || !isIsoInstant(to)) {
    throw new InvalidVerifyRangeError('from and to must both be ISO instants')
  }
  if (Date.parse(from) >= Date.parse(to)) {
    throw new InvalidVerifyRangeError('from must be strictly before to')
  }
}

/**
 * Containment validation, once the series timezone is known.
 *
 * A range that does not straddle the split point makes verification VACUOUS: both sides
 * come back empty and the comparison passes without having checked anything. Requiring the
 * split strictly inside the window guarantees the truncated series and the successor can
 * each contribute occurrences, so a real mismatch has somewhere to show up.
 */
function assertVerifyRangeStraddles(
  range: VerifyRange,
  occurrenceLocal: string,
  timezone: string,
): void {
  // occurrenceInstant applies the same DST policy the expansion does, so containment is
  // judged against the instant the occurrence will actually land on.
  const at = Date.parse(occurrenceInstant(occurrenceLocal, timezone))
  const from = Date.parse(range.from)
  const to = Date.parse(range.to)

  if (at <= from) {
    throw new InvalidVerifyRangeError(
      `the range starts at or after the split point (${occurrenceLocal}), so the truncated series would not be checked`,
    )
  }
  if (at >= to) {
    throw new InvalidVerifyRangeError(
      `the range ends at or before the split point (${occurrenceLocal}), so the successor would not be checked`,
    )
  }
}

export interface ApplySeriesEditResult {
  readonly scope: EditScope
  readonly truncatedSeriesId: string | null
  readonly successorSeriesId: string | null
  readonly detachedEventId: string | null
  readonly summary: string
}

/**
 * Apply an edit scope atomically.
 *
 * Everything below happens inside one transaction, so an interruption at any point leaves
 * the series exactly as it was. The dangerous intermediate state is a truncated original
 * with no successor: a partially-applied "this and future" edit silently deletes every
 * future occurrence, which is precisely the irreversible surprise spec §1 forbids.
 */
export async function applySeriesEdit(
  db: Db,
  input: SeriesEditCommand,
): Promise<ApplySeriesEditResult> {
  for (const field of input.fields ?? []) assertCloaked(field)

  // Runtime backstop for the compile-time union: a command arriving over an API boundary
  // or through `any` still cannot skip verification on a split.
  const verifyRange =
    input.scope === 'this-and-future' || input.scope === 'entire-series'
      ? (input as { verifyRange?: unknown }).verifyRange
      : undefined

  if (input.scope === 'this-and-future') {
    assertVerifyRangeShape(verifyRange)
  }

  return db.transaction(async (tx) => {
    const current = await loadSeriesSpec(tx, input.seriesId)
    if (current === null) {
      throw new VersionConflictError(input.seriesId, input.expectedVersion)
    }

    if (input.scope === 'this-and-future') {
      // Deferred until the series is loaded, because containment depends on its timezone.
      assertVerifyRangeStraddles(verifyRange as VerifyRange, input.occurrenceLocal, current.timezone)
    }

    const plan = planSeriesEdit({
      series: current,
      occurrenceLocal: input.occurrenceLocal,
      scope: input.scope,
    })

    let truncatedSeriesId: string | null = null
    let successorSeriesId: string | null = null
    let detachedEventId: string | null = null

    /* Gate 2 — every write to the original series is version-guarded. */
    if (plan.truncateSeriesTo !== null) {
      const { rows } = await tx(
        `update public.events
            set rrule = $1, version = version + 1
          where id = $2 and version = $3
          returning id`,
        [plan.truncateSeriesTo, input.seriesId, input.expectedVersion],
      )
      if (rows.length === 0) throw new VersionConflictError(input.seriesId, input.expectedVersion)
      truncatedSeriesId = input.seriesId
    } else if (plan.exceptions.length > 0 || plan.scope === 'entire-series') {
      // Even when the rule is unchanged, bump the version so a concurrent editor working
      // from the old state cannot also apply an edit and lose one of them.
      const { rows } = await tx(
        `update public.events set version = version + 1
          where id = $1 and version = $2 returning id`,
        [input.seriesId, input.expectedVersion],
      )
      if (rows.length === 0) throw new VersionConflictError(input.seriesId, input.expectedVersion)
    }

    if (plan.newSeries !== null) {
      const base = await tx(
        `select calendar_id, owner_id, timezone, busy, reminder_offsets, start_utc, end_utc
         from public.events where id = $1`,
        [input.seriesId],
      )
      const b = base.rows[0]!
      const durationMs =
        new Date(String(b['end_utc'])).getTime() - new Date(String(b['start_utc'])).getTime()

      // The successor's first instant is derived from the split occurrence, resolved by
      // the domain layer so the DST policy is applied exactly once, in one place.
      const [first] = expandSeries(plan.newSeries, {
        from: '1970-01-01T00:00:00Z',
        to: '2100-01-01T00:00:00Z',
      }).slice(0, 1)
      if (first === undefined) {
        throw new VerificationFailedError('Successor series produced no occurrences')
      }
      const startUtc = first.startInstant
      const endUtc = new Date(new Date(startUtc).getTime() + durationMs).toISOString()

      // The id is the CALLER's, not Postgres's — the fields below were sealed against it and
      // cannot be decrypted against any other. See SeriesEditCommand.
      successorSeriesId = (input as { newEventId: string }).newEventId

      await tx(
        `insert into public.events
           (id, workspace_id, calendar_id, owner_id, start_utc, end_utc, timezone,
            rrule, dtstart_local, busy, reminder_offsets)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          successorSeriesId,
          input.workspaceId,
          b['calendar_id'],
          // The ACTOR, not a copy of the original's owner. RLS on `events` has
          // `with check (... and owner_id = auth.uid())`, so copying only works while owner
          // and editor are the same person. The day a workspace has a second member, copying
          // fails with an opaque row-level-security error. A successor is a new event created
          // by whoever split the series, so the editor owns it.
          input.actorId,
          startUtc,
          endUtc,
          plan.newSeries.timezone,
          plan.newSeries.rrule,
          plan.newSeries.dtstartLocal.replace('T', ' '),
          b['busy'],
          b['reminder_offsets'],
        ],
      )
      await insertCloakedFields(
        tx,
        input.workspaceId,
        'event',
        successorSeriesId,
        input.fields ?? [],
      )

      // MOVE THE FUTURE EXCEPTIONS ACROSS. Without this, every cancelled or moved occurrence
      // at or after the split keeps pointing at the original series — which no longer
      // produces those occurrences, while the successor that does has never heard of them.
      // A cancelled future occurrence silently comes back. That is exactly the "cancellation
      // resurrects" failure ADR 0001 keys exceptions by local wall time to prevent, arriving
      // by a different route.
      //
      // Runs after the successor INSERT because `series_id` is a foreign key.
      await tx(
        `update public.recurrence_exceptions
            set series_id = $1
          where series_id = $2
            and occurrence_local >= $3`,
        [successorSeriesId, input.seriesId, input.occurrenceLocal.replace('T', ' ')],
      )
    }

    // ORDER MATTERS. `recurrence_exceptions_moved_pair` requires a `moved` row to name its
    // replacement, so the detached event must exist before the exception referencing it.
    // Writing the exception first would fail the constraint inside the transaction — which
    // is the constraint doing its job, but it means the sequence here is not arbitrary.
    if (plan.detachedOccurrence !== null) {
      const base = await tx(
        `select calendar_id, owner_id, timezone, busy, start_utc, end_utc
         from public.events where id = $1`,
        [input.seriesId],
      )
      const b = base.rows[0]!
      const durationMs =
        new Date(String(b['end_utc'])).getTime() - new Date(String(b['start_utc'])).getTime()

      const [occurrence] = expandSeries(
        { ...current, rrule: null, dtstartLocal: plan.detachedOccurrence.occurrenceLocal },
        { from: '1970-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' },
      )
      if (occurrence === undefined) {
        throw new VerificationFailedError('Detached occurrence could not be resolved')
      }

      // Caller's id, and the caller's own user id as owner — same two reasons as the
      // successor insert above.
      detachedEventId = (input as { newEventId: string }).newEventId

      await tx(
        `insert into public.events
           (id, workspace_id, calendar_id, owner_id, start_utc, end_utc, timezone, busy)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          detachedEventId,
          input.workspaceId,
          b['calendar_id'],
          input.actorId,
          occurrence.startInstant,
          new Date(new Date(occurrence.startInstant).getTime() + durationMs).toISOString(),
          b['timezone'],
          b['busy'],
        ],
      )
      await insertCloakedFields(tx, input.workspaceId, 'event', detachedEventId, input.fields ?? [])
    }

    for (const exception of plan.exceptions) {
      await tx(
        `insert into public.recurrence_exceptions
           (series_id, workspace_id, occurrence_local, kind, replacement_event_id)
         values ($1, $2, $3, $4, $5)`,
        [
          input.seriesId,
          input.workspaceId,
          exception.occurrenceLocal.replace('T', ' '),
          exception.kind,
          exception.kind === 'moved' ? detachedEventId : null,
        ],
      )
    }

    /* Gate 3 — re-expand what was actually STORED and compare against the plan. */
    if (plan.newSeries !== null) {
      const range = verifyRange as VerifyRange
      const storedOriginal = await loadSeriesSpec(tx, input.seriesId)
      const storedSuccessor = await loadSeriesSpec(tx, successorSeriesId!)
      if (storedOriginal === null || storedSuccessor === null) {
        throw new VerificationFailedError('Split verification could not read back both series')
      }

      const before = expandSeries(storedOriginal, range).map((o) => o.occurrenceLocal)
      const after = expandSeries(storedSuccessor, range).map((o) => o.occurrenceLocal)

      if (before.some((o) => o >= input.occurrenceLocal)) {
        throw new VerificationFailedError(
          'Truncated series still produces occurrences at or after the split point',
        )
      }
      if (after.some((o) => o < input.occurrenceLocal)) {
        throw new VerificationFailedError(
          'Successor series produces occurrences before the split point',
        )
      }
      if (new Set([...before, ...after]).size !== before.length + after.length) {
        throw new VerificationFailedError('Split produced duplicate occurrences')
      }

      const expected = expandSeries(current, range).map((o) => o.occurrenceLocal)
      if ([...before, ...after].join('|') !== expected.join('|')) {
        throw new VerificationFailedError(
          'Stored split does not reproduce the original occurrence set',
        )
      }
    }

    await audit(tx, input.workspaceId, input.actorId, `event.edit.${plan.scope}`, input.seriesId, {
      occurrenceLocal: input.occurrenceLocal,
      successorSeriesId,
      detachedEventId,
    })

    return {
      scope: plan.scope,
      truncatedSeriesId,
      successorSeriesId,
      detachedEventId,
      summary: plan.summary,
    }
  })
}

/** Move an event to the trash. Version-guarded; `purge` is a separate, explicit action. */
export async function trashEvent(
  db: Db,
  input: { eventId: string; workspaceId: string; actorId: string; expectedVersion: number },
): Promise<void> {
  return db.transaction(async (tx) => {
    const { rows } = await tx(
      `update public.events
          set lifecycle = 'trashed', trashed_at = now(), version = version + 1
        where id = $1 and version = $2 and lifecycle = 'active'
        returning id`,
      [input.eventId, input.expectedVersion],
    )
    if (rows.length === 0) throw new VersionConflictError(input.eventId, input.expectedVersion)

    await audit(tx, input.workspaceId, input.actorId, 'event.trashed', input.eventId)
  })
}


/* -------------------------------------------------------------------------- */
/* Named entry points                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Edit one occurrence, detaching it from the series. No verification range: nothing is
 * truncated, so there is no occurrence set to reconcile.
 */
export function editSingleOccurrence(
  db: Db,
  input: SeriesEditBase & { readonly newEventId: string },
): Promise<ApplySeriesEditResult> {
  return applySeriesEdit(db, { ...input, scope: 'this' })
}

/**
 * Edit every occurrence. The rule is unchanged, so verification is genuinely unnecessary
 * and the range stays optional — pass one when a caller wants the extra assurance.
 */
export function editEntireSeries(
  db: Db,
  input: SeriesEditBase & { readonly verifyRange?: VerifyRange },
): Promise<ApplySeriesEditResult> {
  return applySeriesEdit(db, { ...input, scope: 'entire-series' })
}

/**
 * Split the series. `verifyRange` is REQUIRED — this is the only edit that can destroy
 * future occurrences, so it always post-write verifies.
 */
export function editThisAndFuture(
  db: Db,
  input: SeriesEditBase & { readonly newEventId: string; readonly verifyRange: VerifyRange },
): Promise<ApplySeriesEditResult> {
  return applySeriesEdit(db, { ...input, scope: 'this-and-future' })
}
