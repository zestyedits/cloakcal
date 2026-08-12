-- Rename and recolour a calendar — the first write path calendars have ever had.
--
-- Calendars are created by `bootstrapWorkspace()` at the key ceremony and then frozen:
-- no RPC touches them. This adds the two edits the settings screen needs. Create and
-- delete stay deliberately absent — deleting a calendar needs an answer for its events
-- (`events.calendar_id` is `on delete restrict`), and shipping delete without that answer
-- would trade a missing feature for a dead end.
--
-- The name is Tier B: `display_name` lives in cloaked_fields under the `calendar` subject
-- (allowlisted since 0004), so a rename is a client-sealed value replacement — same
-- subject id, same derived key, new ciphertext. The colour is Tier A: it renders on
-- busy-only views for audiences that never see content, so it was never secret.
--
-- NO VERSION GUARD, per 0017: one row, one person, an occasional rename. Calendars have
-- no version column and do not gain one here for symmetry's sake.

create or replace function public.update_calendar(
  p_calendar_id uuid,
  -- Null means unchanged. The allowlist matches the tokens that actually have CSS —
  -- an unknown token would render as the slate fallback and look like a bug, so it is
  -- refused loudly instead of stored quietly.
  p_color_token text  default null,
  -- [{ "field_name": "display_name", "ciphertext": "<hex>", "nonce": "<hex>", ... }]
  p_fields      jsonb default '[]'::jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  field jsonb;
  bytes bytea;
begin
  select workspace_id into v_workspace_id
    from public.calendars
   where id = p_calendar_id and lifecycle = 'active';
  if not found then
    raise exception 'calendar % does not exist', p_calendar_id
      using errcode = 'no_data_found', hint = 'calendar_not_found';
  end if;

  if p_color_token is not null then
    if p_color_token not in ('indigo', 'teal', 'violet', 'rose', 'slate') then
      raise exception 'unknown color token %', p_color_token
        using errcode = 'check_violation', hint = 'unknown_color';
    end if;
    update public.calendars set color_token = p_color_token where id = p_calendar_id;
  end if;

  for field in select * from jsonb_array_elements(p_fields)
  loop
    bytes := decode(field ->> 'ciphertext', 'hex');

    -- Same floor as events and contacts: AES-GCM output is at least its 16-byte tag, and
    -- anything shorter is a client that skipped encryption. A calendar name in the clear
    -- is a list of the areas of somebody's life.
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
      'calendar', p_calendar_id, v_workspace_id, field ->> 'field_name',
      bytes, decode(field ->> 'nonce', 'hex'),
      (field ->> 'alg')::public.cloak_alg,
      coalesce((field ->> 'key_version')::integer, 1)
    )
    on conflict (subject_type, subject_id, field_name) do update
      set ciphertext  = excluded.ciphertext,
          nonce       = excluded.nonce,
          alg         = excluded.alg,
          key_version = excluded.key_version;
  end loop;

  -- Counts and the colour only. The colour is Tier A; the name never appears anywhere in
  -- plaintext, including here.
  insert into public.audit_log (workspace_id, actor_id, action, subject_type, subject_id, detail)
  values (
    v_workspace_id, auth.uid(), 'calendar.update', 'calendar', p_calendar_id,
    jsonb_strip_nulls(jsonb_build_object(
      'fields_set', jsonb_array_length(p_fields),
      'color', p_color_token
    ))
  );
end;
$$;

revoke all     on function public.update_calendar(uuid, text, jsonb) from public, anon;
grant  execute on function public.update_calendar(uuid, text, jsonb) to authenticated;
