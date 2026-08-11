-- M3 — atomic event creation from the browser.
--
-- WHY A FUNCTION AND NOT TWO INSERTS. An event and its cloaked fields are one thing. Two
-- PostgREST calls cannot be one transaction, so a failure between them leaves an event with
-- no title: a row that renders as "Private event" forever, indistinguishable from a
-- decryption failure. The compensating delete some codebases reach for is itself a second
-- request that can fail. One function, one transaction, no window.
--
-- SECURITY INVOKER, NOT DEFINER. This runs as the caller, so RLS applies to every statement
-- inside it exactly as it would outside. A definer-rights version would run as the function
-- owner and bypass the workspace boundary entirely — turning the one place all writes flow
-- through into the one place the boundary does not hold. The function therefore grants no
-- privilege the caller did not already have; its only job is atomicity.
--
-- TIER DISCIPLINE. Content arrives already encrypted. There is no parameter that accepts a
-- title, and there is nowhere to put one: the enum has a single value, aes-256-gcm-v1, so a
-- caller who tried to send plaintext could not name an algorithm for it.

create or replace function public.create_cloaked_event(
  p_event_id       uuid,
  p_workspace_id   uuid,
  p_calendar_id    uuid,
  p_timezone       text,
  p_start_utc      timestamptz,
  p_end_utc        timestamptz,
  p_dtstart_local  timestamp default null,
  p_all_day        boolean   default false,
  p_start_date     date      default null,
  p_end_date       date      default null,
  p_rrule          text      default null,
  p_busy           public.busy_status default 'busy',
  -- [{ "field_name": "title", "ciphertext": "<hex>", "nonce": "<hex>",
  --    "alg": "aes-256-gcm-v1", "key_version": 1 }]
  p_fields         jsonb     default '[]'::jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  field jsonb;
  bytes bytea;
begin
  insert into public.events (
    id, workspace_id, calendar_id, owner_id, timezone,
    start_utc, end_utc, dtstart_local, all_day, start_date, end_date, rrule, busy
  )
  values (
    p_event_id, p_workspace_id, p_calendar_id, auth.uid(), p_timezone,
    p_start_utc, p_end_utc, p_dtstart_local, p_all_day, p_start_date, p_end_date, p_rrule, p_busy
  );

  for field in select * from jsonb_array_elements(p_fields)
  loop
    bytes := decode(field ->> 'ciphertext', 'hex');

    -- AES-GCM output is at least the 16-byte tag, and in practice more. A shorter value is
    -- not ciphertext: it is a client that skipped encryption, or hex that failed to decode.
    -- Catching it here means the mistake cannot reach storage even once.
    if octet_length(bytes) < 16 then
      raise exception
        'field % is % bytes, too short to be AES-GCM output - was it encrypted?',
        field ->> 'field_name', octet_length(bytes)
        using errcode = 'check_violation';
    end if;

    insert into public.cloaked_fields (
      subject_type, subject_id, workspace_id, field_name, ciphertext, nonce, alg, key_version
    )
    values (
      'event',
      p_event_id,
      p_workspace_id,
      field ->> 'field_name',
      bytes,
      decode(field ->> 'nonce', 'hex'),
      (field ->> 'alg')::public.cloak_alg,
      coalesce((field ->> 'key_version')::integer, 1)
    );
  end loop;

  -- Metadata only. An audit entry that named the event would undo the encryption it exists
  -- to record.
  insert into public.audit_log (workspace_id, actor_id, action, subject_type, subject_id, detail)
  values (
    p_workspace_id, auth.uid(), 'event.create', 'event', p_event_id,
    jsonb_build_object('field_count', jsonb_array_length(p_fields), 'recurring', p_rrule is not null)
  );

  return p_event_id;
end;
$$;

revoke all on function public.create_cloaked_event(
  uuid, uuid, uuid, text, timestamptz, timestamptz, timestamp, boolean, date, date, text,
  public.busy_status, jsonb
) from public;

grant execute on function public.create_cloaked_event(
  uuid, uuid, uuid, text, timestamptz, timestamptz, timestamp, boolean, date, date, text,
  public.busy_status, jsonb
) to authenticated;
