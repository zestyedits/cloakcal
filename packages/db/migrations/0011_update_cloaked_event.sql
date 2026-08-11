-- M4 — editing an event from the browser.
--
-- Third mutation ported from packages/db/src/events.ts. Scope is the WHOLE event: content
-- (title, location, notes) on anything, plus timing on a non-recurring event. A recurring
-- event changes every occurrence. "Just this one" and "this and future" are the series
-- splits, and they come later.
--
-- SECURITY INVOKER, like 0007 and 0008. The function runs as the caller, so RLS decides
-- which rows it can even see. A definer-rights version would let any authenticated user edit
-- any event id they could guess.
--
-- TIER DISCIPLINE. Content arrives already encrypted. There is no parameter that accepts a
-- title, and nowhere to put one — `events` has no such column.

-- ---------------------------------------------------------------------------
-- Why the temporal parameters are TEXT and not `timestamp`
-- ---------------------------------------------------------------------------
--
-- This is the least obvious decision in the file, so: Postgres SILENTLY DISCARDS a timezone
-- offset when parsing into `timestamp without time zone`.
--
--   select timestamp '2026-05-19T09:00:00+05:00'   ->   2026-05-19 09:00:00
--
-- A client that sent `zoned.toString()` instead of `local.toString()` — the exact mistake
-- new-event.tsx carries a comment warning about — would store an anchor five hours off the
-- one the user picked, with no error. And a read-back check comparing the stored value to
-- the same typed parameter would compare two copies of the SAME lossy parse and pass.
--
-- Taking text and validating the shape before the cast closes that: once the regex matches,
-- `::timestamp` is total and loses nothing, so the comparison at the end is exact. The format
-- is the one loadSeriesSpec already reads back, so client, function and reader all speak one
-- representation.

create or replace function private.canonical_local(p_value text)
returns timestamp
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_value !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$' then
    raise exception 'local time % is not YYYY-MM-DDTHH:MM:SS', p_value
      using errcode = 'check_violation', hint = 'noncanonical_time';
  end if;
  return p_value::timestamp;
end;
$$;

create or replace function private.canonical_instant(p_value text)
returns timestamptz
language plpgsql
immutable
set search_path = ''
as $$
begin
  -- Trailing Z only. An offset here would mean the client resolved the wall clock to an
  -- instant using its own rules; ADR 0001 puts that resolution in one place, and this is
  -- not it.
  if p_value !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$' then
    raise exception 'instant % is not an ISO UTC instant ending in Z', p_value
      using errcode = 'check_violation', hint = 'noncanonical_time';
  end if;
  return p_value::timestamptz;
end;
$$;

revoke all on function private.canonical_local(text) from public, anon;
revoke all on function private.canonical_instant(text) from public, anon;
grant execute on function private.canonical_local(text) to authenticated;
grant execute on function private.canonical_instant(text) to authenticated;

-- 0010 swept `public` and stopped there, which left `private.assert_cloaked_subject_matches`
-- (the trigger function from 0004) still granted to anon. Not reachable — anon has no USAGE
-- on this schema — but "unreachable by a second mechanism" is not the guarantee the posture
-- sweep is supposed to be asserting, and the sweep now covers both schemas.
revoke execute on all functions in schema private from public, anon;
grant execute on function private.is_workspace_member(uuid) to authenticated;
grant execute on function private.canonical_local(text) to authenticated;
grant execute on function private.canonical_instant(text) to authenticated;

-- ---------------------------------------------------------------------------

create or replace function public.update_cloaked_event(
  p_event_id         uuid,
  p_expected_version integer,
  p_dtstart_local    text    default null,
  p_start_utc        text    default null,
  p_end_utc          text    default null,
  -- [{ "field_name": "title", "ciphertext": "<hex>", "nonce": "<hex>",
  --    "alg": "aes-256-gcm-v1", "key_version": 1 }]
  p_fields           jsonb   default '[]'::jsonb,
  -- Field names to remove. A cleared field is an ABSENT row, never an empty-string seal:
  -- an empty encrypted string decrypts to nothing and renders as an untitled event, which
  -- is not what "I deleted my notes" should look like.
  p_clear_fields     text[]  default '{}'
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row          public.events;
  v_dtstart      timestamp;
  v_start        timestamptz;
  v_end          timestamptz;
  v_retimed      boolean;
  field          jsonb;
  bytes          bytea;
  v_check        record;
begin
  -- Locked, not merely read. 0008 reads then re-checks after the UPDATE to turn a race into
  -- an honest conflict; `for update` prevents the race instead of detecting it. The three
  -- failure modes stay distinguishable, because the UI has to say which one happened.
  select * into v_row from public.events where id = p_event_id for update;

  if not found then
    raise exception 'event % does not exist', p_event_id
      using errcode = 'no_data_found', hint = 'event_not_found';
  end if;

  if v_row.lifecycle <> 'active' then
    raise exception 'event % is %', p_event_id, v_row.lifecycle
      using errcode = 'object_not_in_prerequisite_state', hint = 'event_trashed';
  end if;

  if v_row.version <> p_expected_version then
    raise exception 'event % was changed by someone else (expected %, found %)',
      p_event_id, p_expected_version, v_row.version
      using errcode = 'serialization_failure', hint = 'version_conflict';
  end if;

  v_retimed := p_dtstart_local is not null or p_start_utc is not null or p_end_utc is not null;

  if v_retimed then
    if p_dtstart_local is null or p_start_utc is null or p_end_utc is null then
      raise exception 'a retime needs all three of dtstart_local, start_utc and end_utc'
        using errcode = 'check_violation', hint = 'incomplete_retime';
    end if;

    -- REFUSED, LOUDLY, rather than half-done. Moving a series anchor leaves every
    -- recurrence_exceptions row keyed to the OLD wall time, so cancelled occurrences would
    -- quietly reappear at the new one — the failure ADR 0001 keys exceptions by local time
    -- to prevent. Shifting them is the right fix and belongs with the series-edit work; the
    -- UI does not offer this today, so reaching here is a client bug.
    if v_row.rrule is not null then
      raise exception 'cannot retime a recurring series yet'
        using errcode = 'object_not_in_prerequisite_state', hint = 'retime_recurring_unsupported';
    end if;

    if v_row.all_day then
      raise exception 'cannot retime an all-day event yet'
        using errcode = 'object_not_in_prerequisite_state', hint = 'all_day_unsupported';
    end if;

    v_dtstart := private.canonical_local(p_dtstart_local);
    v_start   := private.canonical_instant(p_start_utc);
    v_end     := private.canonical_instant(p_end_utc);

    if v_end < v_start then
      raise exception 'end is before start'
        using errcode = 'check_violation', hint = 'inverted_range';
    end if;
  end if;

  update public.events
     set dtstart_local = case when v_retimed then v_dtstart else dtstart_local end,
         start_utc     = case when v_retimed then v_start   else start_utc     end,
         end_utc       = case when v_retimed then v_end     else end_utc       end,
         -- Explicit. The events_touch trigger sets updated_at and does NOT bump version.
         version       = version + 1
   where id = p_event_id;

  -- Upserts, because cloaked_fields is unique on (subject_type, subject_id, field_name).
  -- Editing in place keeps the same subject id, so the AAD is unchanged and untouched
  -- fields keep working — only the changed ones need to arrive.
  for field in select * from jsonb_array_elements(p_fields)
  loop
    bytes := decode(field ->> 'ciphertext', 'hex');

    -- Same floor as 0007. AES-GCM output is at least the 16-byte tag; anything shorter is a
    -- client that skipped encryption, and it must not reach storage even once.
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
      'event', p_event_id, v_row.workspace_id, field ->> 'field_name',
      bytes, decode(field ->> 'nonce', 'hex'),
      (field ->> 'alg')::public.cloak_alg,
      coalesce((field ->> 'key_version')::integer, 1)
    )
    on conflict (subject_type, subject_id, field_name) do update
      set ciphertext  = excluded.ciphertext,
          nonce       = excluded.nonce,
          alg         = excluded.alg,
          key_version = excluded.key_version,
          version     = public.cloaked_fields.version + 1;
  end loop;

  if array_length(p_clear_fields, 1) is not null then
    delete from public.cloaked_fields
     where subject_type = 'event'
       and subject_id = p_event_id
       and field_name = any(p_clear_fields);
  end if;

  -- READ BACK WHAT LANDED, and compare it to what was asked for.
  --
  -- Not paranoia about our own UPDATE: it is a check on everything BETWEEN intent and
  -- committed state — a type coercion, a constraint, a trigger that does not exist yet. It
  -- is a fresh SELECT rather than a RETURNING clause for exactly that reason. Comparison is
  -- on the canonical text form, because comparing two `timestamp` values would compare two
  -- copies of the same parse and could not see a dropped offset.
  if v_retimed then
    select to_char(e.dtstart_local, 'YYYY-MM-DD"T"HH24:MI:SS') as dtstart,
           e.start_utc, e.end_utc, e.version
      into v_check
      from public.events e where e.id = p_event_id;

    if v_check.dtstart is distinct from p_dtstart_local
       or v_check.start_utc is distinct from v_start
       or v_check.end_utc is distinct from v_end
       or v_check.version <> p_expected_version + 1 then
      raise exception 'stored event does not match the requested change; nothing was saved'
        using errcode = 'integrity_constraint_violation', hint = 'stored_plan_mismatch';
    end if;
  end if;

  -- Metadata only. Naming a field's VALUE here would undo the encryption the audit log
  -- exists to record against; the field NAMES are Tier A and already visible in the schema.
  insert into public.audit_log (
    workspace_id, actor_id, action, subject_type, subject_id, detail
  )
  values (
    v_row.workspace_id, auth.uid(), 'event.updated', 'event', p_event_id,
    jsonb_build_object(
      'from_version', p_expected_version,
      'retimed', v_retimed,
      'fields_set', jsonb_array_length(p_fields),
      'fields_cleared', coalesce(array_length(p_clear_fields, 1), 0)
    )
  );
end;
$$;

revoke all on function public.update_cloaked_event(uuid, integer, text, text, text, jsonb, text[])
  from public, anon;
grant execute on function public.update_cloaked_event(uuid, integer, text, text, text, jsonb, text[])
  to authenticated;
