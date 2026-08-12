-- Delete ONE occurrence of a repeating event.
--
-- Fifth mutation ported to an RPC, and the smallest: it writes a single
-- `recurrence_exceptions` row with `kind = 'cancelled'`. Everything needed for this has
-- existed since 0004 — the table, the unique key on (series_id, occurrence_local), the RLS
-- policy — and the read path in apps/web/src/server/events.ts has always honoured such rows.
-- Nothing had ever written one, so the affordance was the only missing piece.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS NOT A TRASH, AND WHY IT DOES NOT TOUCH cloaked_fields
-- ---------------------------------------------------------------------------
--
-- `trash_cloaked_event` flips a lifecycle on the events ROW, and a repeating event is one
-- row — so trashing it removes every occurrence. That is the right answer for "delete this
-- event" and the wrong one for "delete this Tuesday".
--
-- An occurrence is not a row. It is a value produced by expanding the series, so the only
-- way to remove one is to record a subtraction against the rule. There is no content to
-- delete either: the ciphertext belongs to the series, and the other occurrences still need
-- it. This function therefore touches no `cloaked_fields` at all, which is also why it needs
-- no key and works whether or not the calendar is unlocked.
--
-- ---------------------------------------------------------------------------
-- LOCAL WALL TIME, AS TEXT
-- ---------------------------------------------------------------------------
--
-- The occurrence is keyed by its ORIGINAL local wall time, per ADR 0001. If it were keyed by
-- an instant, a DST shift would change the key and every previously cancelled occurrence
-- would silently reappear — the failure 0004 wrote the column as `timestamp` to prevent.
--
-- It arrives as TEXT and is regex-validated before the cast, because Postgres silently drops
-- a timezone offset when parsing into `timestamp without time zone`. A client that sent a
-- zoned string would cancel an occurrence hours away from the one the user clicked, with no
-- error anywhere. See the long comment above private.canonical_local in 0011.

create or replace function public.cancel_occurrence(
  p_series_id        uuid,
  p_expected_version integer,
  p_occurrence_local text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row        public.events;
  v_occurrence timestamp;
  v_existing   text;
begin
  -- Read first so the failure modes stay distinguishable, and lock so the version check and
  -- the insert cannot be split by a concurrent writer. RLS applies here, so a series in
  -- someone else's workspace is simply not found — indistinguishable from a bad id, which is
  -- the correct disclosure.
  select * into v_row from public.events where id = p_series_id for update;

  if not found then
    raise exception 'event % does not exist', p_series_id
      using errcode = 'no_data_found', hint = 'event_not_found';
  end if;

  if v_row.lifecycle <> 'active' then
    raise exception 'event % is %', p_series_id, v_row.lifecycle
      using errcode = 'object_not_in_prerequisite_state', hint = 'event_trashed';
  end if;

  if v_row.version <> p_expected_version then
    raise exception 'event % was changed by someone else (expected %, found %)',
      p_series_id, p_expected_version, v_row.version
      using errcode = 'serialization_failure', hint = 'version_conflict';
  end if;

  -- Cancelling "the occurrence" of a one-off event means deleting the event, and the caller
  -- asking for it means the client and the database disagree about what this row is. Say so
  -- rather than writing an exception row against a series that does not exist.
  if v_row.rrule is null then
    raise exception 'event % does not repeat, so it has no occurrences to cancel', p_series_id
      using errcode = 'check_violation', hint = 'not_a_series';
  end if;

  v_occurrence := private.canonical_local(p_occurrence_local);

  -- An existing exception at this wall time is NOT an error by itself, but the two kinds mean
  -- very different things and must not be conflated:
  --
  --   'cancelled' — already deleted. Idempotent; return quietly so a double-click or a retry
  --                 after a dropped response does not surface a failure for work already done.
  --   'moved'     — this occurrence was detached by a split and now lives as its own event
  --                 row. Cancelling the series slot would orphan that row: it would keep
  --                 existing, keep rendering, and no longer be reachable from the series.
  --                 Deleting the detached event is a different action on a different id.
  select kind into v_existing
    from public.recurrence_exceptions
   where series_id = p_series_id
     and occurrence_local = v_occurrence;

  if found then
    if v_existing = 'cancelled' then
      return;
    end if;
    raise exception
      'occurrence % of event % was moved to its own event and must be deleted there',
      p_occurrence_local, p_series_id
      using errcode = 'check_violation', hint = 'occurrence_detached';
  end if;

  insert into public.recurrence_exceptions (
    series_id, workspace_id, occurrence_local, kind, replacement_event_id
  )
  values (p_series_id, v_row.workspace_id, v_occurrence, 'cancelled', null);

  -- The series row is untouched apart from this. Bumping the version anyway is deliberate:
  -- the set of occurrences the caller is looking at HAS changed, so a second tab holding the
  -- old version must be told to reload rather than being allowed to apply an edit computed
  -- against an occurrence list that no longer exists.
  update public.events
     set version = version + 1
   where id = p_series_id;

  -- Records THAT an occurrence went, and when in wall-clock terms, but nothing about what it
  -- was. The title is ciphertext and stays that way; the audit log is a Tier A surface.
  insert into public.audit_log (
    workspace_id, actor_id, action, subject_type, subject_id, detail
  )
  values (
    v_row.workspace_id, auth.uid(), 'event.occurrence_cancelled', 'event', p_series_id,
    jsonb_build_object(
      'occurrence_local', p_occurrence_local,
      'from_version', p_expected_version
    )
  );
end;
$$;

-- BOTH revokes are required, and neither is redundant. Supabase's default privileges grant
-- EXECUTE to `anon` outright, and Postgres separately grants it to PUBLIC on every function
-- at creation, which `anon` inherits through. Revoking one leaves the other. The sweep in
-- packages/db/test/security-posture.test.ts fails if any function in `public` is executable
-- by `anon`; trust it rather than reasoning about grants.
revoke all     on function public.cancel_occurrence(uuid, integer, text) from public, anon;
grant  execute on function public.cancel_occurrence(uuid, integer, text) to authenticated;
