-- Create a calendar — the write path the sidebar's "Add calendar" row needed.
--
-- Until now every calendar came from `bootstrapWorkspace()` at the key ceremony and was
-- frozen except for 0019's rename/recolour. DELETE STAYS DELIBERATELY ABSENT, same
-- deferral as 0019 recorded: deleting a calendar needs an answer for its events
-- (`events.calendar_id` is `on delete restrict`), and shipping delete without that answer
-- would trade a missing feature for a dead end.
--
-- The id is CLIENT-GENERATED, like 0007's p_event_id: the sealed display_name's AEAD
-- binds to the calendar id, so the id must exist before the ciphertext can. The name is
-- Tier B and arrives only as ciphertext — there is no parameter that could carry it in
-- the clear (rule 5 by construction, not by review).
--
-- `is_default` IS NOT A PARAMETER. bootstrapWorkspace() owns the default, and the
-- partial unique index `calendars_one_default_per_workspace` makes a second one
-- unrepresentable; a created calendar is always an ordinary one.
--
-- NO VERSION GUARD, per 0019: calendars have no version column, and a create has nothing
-- to guard anyway.

create or replace function public.create_calendar(
  p_calendar_id  uuid,
  p_workspace_id uuid,
  p_color_token  text,
  -- [{ "field_name": "display_name", "ciphertext": "<hex>", "nonce": "<hex>", ... }]
  p_fields       jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  field jsonb;
  bytes bytea;
  v_has_name boolean := false;
begin
  -- RLS makes someone else's workspace invisible, so cross-workspace and nonexistent
  -- read identically — the same distinguishable-slug family as 0017-0020.
  perform 1 from public.workspaces where id = p_workspace_id and lifecycle = 'active';
  if not found then
    raise exception 'workspace % does not exist', p_workspace_id
      using errcode = 'no_data_found', hint = 'workspace_not_found';
  end if;

  -- Same allowlist as 0019: an unknown token renders as the slate fallback and looks
  -- like a bug, so it is refused loudly instead of stored quietly.
  if p_color_token not in ('indigo', 'teal', 'violet', 'rose', 'slate') then
    raise exception 'unknown color token %', p_color_token
      using errcode = 'check_violation', hint = 'unknown_color';
  end if;

  -- sort_order lands after the existing calendars so the settings list stays stable.
  insert into public.calendars (id, workspace_id, color_token, is_default, sort_order)
  values (
    p_calendar_id, p_workspace_id, p_color_token, false,
    coalesce(
      (select max(sort_order) + 1 from public.calendars
        where workspace_id = p_workspace_id and lifecycle = 'active'),
      0
    )
  );

  for field in select * from jsonb_array_elements(p_fields)
  loop
    bytes := decode(field ->> 'ciphertext', 'hex');

    -- Same floor as 0019: AES-GCM output is at least its 16-byte tag, and anything
    -- shorter is a client that skipped encryption. A calendar name in the clear is a
    -- list of the areas of somebody's life.
    if octet_length(bytes) < 16 then
      raise exception
        'field % is % bytes, too short to be AES-GCM output - was it encrypted?',
        field ->> 'field_name', octet_length(bytes)
        using errcode = 'check_violation', hint = 'not_ciphertext';
    end if;

    if field ->> 'field_name' = 'display_name' then
      v_has_name := true;
    end if;

    insert into public.cloaked_fields (
      subject_type, subject_id, workspace_id, field_name, ciphertext, nonce, alg, key_version
    )
    values (
      'calendar', p_calendar_id, p_workspace_id, field ->> 'field_name',
      bytes, decode(field ->> 'nonce', 'hex'),
      (field ->> 'alg')::public.cloak_alg,
      coalesce((field ->> 'key_version')::integer, 1)
    );
  end loop;

  -- A calendar with no sealed name would render as the "Calendar" placeholder forever,
  -- indistinguishable from a decryption failure. One transaction, so refuse it here —
  -- the same reasoning that made 0007 one function instead of two inserts.
  if not v_has_name then
    raise exception 'a new calendar needs a sealed display_name'
      using errcode = 'check_violation', hint = 'missing_name';
  end if;

  -- Colour and counts only. The name never appears anywhere in plaintext, including here.
  insert into public.audit_log (workspace_id, actor_id, action, subject_type, subject_id, detail)
  values (
    p_workspace_id, auth.uid(), 'calendar.create', 'calendar', p_calendar_id,
    jsonb_build_object('color', p_color_token, 'fields_set', jsonb_array_length(p_fields))
  );

  return p_calendar_id;
end;
$$;

-- BOTH revokes, always: Postgres grants EXECUTE to PUBLIC implicitly at creation and
-- Supabase's default privileges grant anon separately; neither revoke covers the other.
revoke all     on function public.create_calendar(uuid, uuid, text, jsonb) from public, anon;
grant  execute on function public.create_calendar(uuid, uuid, text, jsonb) to authenticated;
