-- M4 — series splits. "Just this occurrence" and "this and future".
--
-- Fourth mutation ported from packages/db/src/events.ts, and the one that can destroy data:
-- it is the only edit that removes future occurrences. Everything unusual below is there
-- because of that.
--
-- ---------------------------------------------------------------------------
-- WHERE THE VERIFICATION LIVES, AND WHY IT IS SPLIT IN TWO
-- ---------------------------------------------------------------------------
--
-- The reference implementation's gate 3 re-expands the STORED series after writing and
-- compares the occurrence set against the original. That cannot happen here: expanding an
-- RRULE needs a full RFC 5545 engine, Postgres has none, and hand-rolling one in plpgsql
-- would put a SECOND recurrence implementation in the codebase — which is the thing ADR 0001
-- exists to prevent, since the two would disagree on a DST boundary and nobody would know
-- which was right.
--
-- So the guarantee is decomposed, and the two halves compose back to the same thing:
--
--   3a, in TypeScript, BEFORE the call (see apps/web/src/lib/split-plan.ts):
--       expand(original) == expand(truncated) ++ expand(successor)
--       — the PLAN is lossless. Uses the one recurrence engine.
--
--   3b, here, INSIDE the transaction, AFTER writing:
--       stored values == the plan's values, byte for byte
--       — what landed IS what 3a verified.
--
-- Together: expand(stored) == expand(original). 3b is what makes 3a's conclusion apply to
-- the database rather than to a plan that may not have survived the trip — a dropped
-- timezone offset, a coercion, a trigger. Neither half is sufficient alone, and the reason
-- this decomposition is honest rather than a dodge is that expansion is deterministic in
-- (dtstart_local, timezone, rrule, duration) — all four of which 3b compares.
--
-- ---------------------------------------------------------------------------
-- THE NEW EVENT ID COMES FROM THE CLIENT
-- ---------------------------------------------------------------------------
--
-- Both scopes create a row and file sealed content against it. The AEAD binds ciphertext to
-- the subject id, so the caller must know the id BEFORE sealing. A Postgres-generated id
-- would produce content nobody can ever decrypt — the exact defect packages/db shipped with
-- until it was fixed alongside the 0010 work, invisible because no test decrypted.

create or replace function public.split_cloaked_event(
  p_series_id        uuid,
  p_expected_version integer,
  -- The occurrence the user acted on, as its ORIGINAL local wall time. Never an instant:
  -- ADR 0001 keys exceptions by local time so a DST shift cannot move them.
  p_occurrence_local text,
  p_scope            text,
  -- Client-generated. See above.
  p_new_event_id     uuid,
  -- Replacement rule for the original series. Null for 'this', which truncates nothing.
  p_truncate_rrule   text,
  -- The new row's anchor and derived instants, all resolved client-side by the one DST policy.
  p_new_dtstart_local text,
  p_new_start_utc     text,
  p_new_end_utc       text,
  -- The successor's rule. Null for 'this', which detaches a single non-repeating event.
  p_new_rrule        text    default null,
  p_fields           jsonb   default '[]'::jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row        public.events;
  v_occurrence timestamp;
  v_dtstart    timestamp;
  v_start      timestamptz;
  v_end        timestamptz;
  field        jsonb;
  bytes        bytea;
  v_check      record;
begin
  if p_scope not in ('this', 'this-and-future') then
    raise exception 'unknown split scope %', p_scope
      using errcode = 'check_violation', hint = 'unknown_scope';
  end if;

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

  -- Splitting something that does not repeat is meaningless, and the caller asking for it
  -- means the client and the database disagree about what this row is.
  if v_row.rrule is null then
    raise exception 'event % does not repeat, so it cannot be split', p_series_id
      using errcode = 'check_violation', hint = 'not_a_series';
  end if;

  if p_scope = 'this-and-future' and p_truncate_rrule is null then
    raise exception 'a this-and-future split needs a replacement rule for the original'
      using errcode = 'check_violation', hint = 'missing_truncate_rrule';
  end if;

  v_occurrence := private.canonical_local(p_occurrence_local);
  v_dtstart    := private.canonical_local(p_new_dtstart_local);
  v_start      := private.canonical_instant(p_new_start_utc);
  v_end        := private.canonical_instant(p_new_end_utc);

  if v_end < v_start then
    raise exception 'end is before start'
      using errcode = 'check_violation', hint = 'inverted_range';
  end if;

  -- 1. The original. Truncated for a future split, version-bumped either way so a concurrent
  --    editor working from the old state cannot also apply an edit and lose one of them.
  update public.events
     set rrule   = case when p_scope = 'this-and-future' then p_truncate_rrule else rrule end,
         version = version + 1
   where id = p_series_id;

  -- 2. The new row. `owner_id` is the CALLER, not a copy of the original's: RLS on events has
  --    `with check (... and owner_id = auth.uid())`, so copying only works while the editor
  --    and the owner are the same person.
  insert into public.events (
    id, workspace_id, calendar_id, owner_id, timezone,
    start_utc, end_utc, dtstart_local, rrule, busy, reminder_offsets
  )
  values (
    p_new_event_id, v_row.workspace_id, v_row.calendar_id, auth.uid(), v_row.timezone,
    v_start, v_end, v_dtstart, p_new_rrule, v_row.busy, v_row.reminder_offsets
  );

  -- 3. Content, sealed against p_new_event_id by the caller.
  for field in select * from jsonb_array_elements(p_fields)
  loop
    bytes := decode(field ->> 'ciphertext', 'hex');

    if octet_length(bytes) < 16 then
      raise exception
        'field % is % bytes, too short to be AES-GCM output - was it encrypted?',
        field ->> 'field_name', octet_length(bytes)
        using errcode = 'check_violation', hint = 'not_ciphertext';
    end if;

    insert into public.cloaked_fields (
      subject_type, subject_id, workspace_id, field_name, ciphertext, nonce, alg, key_version
    )
    values (
      'event', p_new_event_id, v_row.workspace_id, field ->> 'field_name',
      bytes, decode(field ->> 'nonce', 'hex'),
      (field ->> 'alg')::public.cloak_alg,
      coalesce((field ->> 'key_version')::integer, 1)
    );
  end loop;

  -- 4. Exceptions.
  if p_scope = 'this' then
    -- ORDER MATTERS: recurrence_exceptions_moved_pair requires a 'moved' row to name its
    -- replacement, so the detached event has to exist first. That is why this is step 4 and
    -- not step 1.
    --
    -- 'moved' rather than 'cancelled' so history can tell "I edited that one" from
    -- "I deleted that one".
    insert into public.recurrence_exceptions (
      series_id, workspace_id, occurrence_local, kind, replacement_event_id
    )
    values (p_series_id, v_row.workspace_id, v_occurrence, 'moved', p_new_event_id);
  else
    -- CARRY THE FUTURE EXCEPTIONS ACROSS. Without this, a cancelled occurrence after the
    -- split point keeps pointing at the original series — which no longer produces it —
    -- while the successor that does has never heard of it, so a cancelled meeting silently
    -- returns. Same failure ADR 0001 keys exceptions by local time to prevent, by a
    -- different route.
    update public.recurrence_exceptions
       set series_id = p_new_event_id
     where series_id = p_series_id
       and occurrence_local >= v_occurrence;
  end if;

  -- 5. Gate 3b. Read back BOTH rows and compare to the plan, on the canonical text form —
  --    comparing two `timestamp` values would compare two copies of the same parse and could
  --    not see a dropped offset. A mismatch rolls the whole transaction back.
  select o.rrule                                                        as old_rrule,
         o.version                                                      as old_version,
         to_char(n.dtstart_local, 'YYYY-MM-DD"T"HH24:MI:SS')            as new_dtstart,
         n.rrule                                                        as new_rrule,
         n.timezone                                                     as new_timezone,
         n.start_utc                                                    as new_start,
         n.end_utc                                                      as new_end
    into v_check
    from public.events o, public.events n
   where o.id = p_series_id and n.id = p_new_event_id;

  if v_check.new_dtstart is distinct from p_new_dtstart_local
     or v_check.new_rrule is distinct from p_new_rrule
     or v_check.new_timezone is distinct from v_row.timezone
     or v_check.new_start is distinct from v_start
     or v_check.new_end is distinct from v_end
     or v_check.old_version <> p_expected_version + 1
     or (p_scope = 'this-and-future' and v_check.old_rrule is distinct from p_truncate_rrule)
     or (p_scope = 'this' and v_check.old_rrule is distinct from v_row.rrule) then
    raise exception 'stored split does not match the plan; nothing was saved'
      using errcode = 'integrity_constraint_violation', hint = 'stored_plan_mismatch';
  end if;

  insert into public.audit_log (
    workspace_id, actor_id, action, subject_type, subject_id, detail
  )
  values (
    v_row.workspace_id, auth.uid(), 'event.split', 'event', p_series_id,
    jsonb_build_object(
      'scope', p_scope,
      'from_version', p_expected_version,
      'new_event_id', p_new_event_id,
      'fields_set', jsonb_array_length(p_fields)
    )
  );

  return p_new_event_id;
end;
$$;

revoke all on function public.split_cloaked_event(
  uuid, integer, text, text, uuid, text, text, text, text, text, jsonb
) from public, anon;
grant execute on function public.split_cloaked_event(
  uuid, integer, text, text, uuid, text, text, text, text, text, jsonb
) to authenticated;
