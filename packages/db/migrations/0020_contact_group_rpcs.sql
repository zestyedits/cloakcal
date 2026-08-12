-- Group management — the half 0017 did not cover.
--
-- 0017 gave contacts and rules their write paths; groups could be *pointed at* by
-- `set_visibility_rule` but never created, renamed, populated or removed. These four
-- complete the set, in the house shape: SECURITY INVOKER so RLS decides what they can
-- touch, a slug in the hint, audited without naming anything.
--
-- NO VERSION GUARDS, per 0017's reasoning verbatim: a group is one row one person renames
-- occasionally, and membership is a checkbox — last write wins IS the semantics.

-- ---------------------------------------------------------------------------
-- upsert_contact_group — create or rename, label sealed by the caller
-- ---------------------------------------------------------------------------
--
-- The id comes from the CLIENT, exactly as it does for contacts and events: the AEAD binds
-- the sealed label to the group id, so the caller must know the id before sealing. A
-- Postgres-generated id would produce a label nobody can ever decrypt.
create or replace function public.upsert_contact_group(
  p_group_id     uuid,
  p_workspace_id uuid,
  -- D8 tiebreak; lower wins. Null keeps the current value (default 100 on insert).
  p_priority     integer default null,
  -- [{ "field_name": "label", "ciphertext": "<hex>", "nonce": "<hex>", ... }]
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
begin
  insert into public.contact_groups (id, workspace_id, priority)
  values (p_group_id, p_workspace_id, coalesce(p_priority, 100))
  on conflict (id) do update
    set priority   = coalesce(p_priority, public.contact_groups.priority),
        updated_at = pg_catalog.now();

  -- Existing group rules carry a denormalised copy of the priority (0017 reads it at rule
  -- write time). Sync it in the same transaction, or the D8 tiebreak could see two
  -- priorities for one group — which surfaces as "sometimes she can see it", the exact
  -- nondeterminism 0017 refused to allow.
  update public.visibility_rules
     set group_priority = coalesce(p_priority, group_priority)
   where workspace_id = p_workspace_id
     and audience = 'group'
     and audience_ref = p_group_id;

  for field in select * from jsonb_array_elements(p_fields)
  loop
    bytes := decode(field ->> 'ciphertext', 'hex');

    -- Same floor as contacts: a group label in the clear — "Clients", "Therapy" — is a
    -- sketch of somebody's life, which is why 0016 gave groups no label column at all.
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
      'contact_group', p_group_id, p_workspace_id, field ->> 'field_name',
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

  insert into public.audit_log (workspace_id, actor_id, action, subject_type, subject_id, detail)
  values (
    p_workspace_id, auth.uid(), 'group.upsert', 'contact_group', p_group_id,
    jsonb_strip_nulls(jsonb_build_object(
      'fields_set', jsonb_array_length(p_fields),
      'priority', p_priority
    ))
  );

  return p_group_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- delete_contact_group — and everything that pointed at it
-- ---------------------------------------------------------------------------
create or replace function public.delete_contact_group(p_group_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_workspace_id uuid;
begin
  select workspace_id into v_workspace_id from public.contact_groups where id = p_group_id;
  if not found then
    raise exception 'group % does not exist', p_group_id
      using errcode = 'no_data_found', hint = 'group_not_found';
  end if;

  -- `audience_ref` has no foreign key — it is polymorphic across contacts and groups —
  -- so nothing cascades. A stale rule would withhold rather than disclose, so this is
  -- tidiness; but a rules list naming groups that no longer exist and cannot be
  -- identified is a support ticket.
  delete from public.visibility_rules
   where workspace_id = v_workspace_id
     and audience = 'group'
     and audience_ref = p_group_id;

  -- The sealed label, same reasoning as delete_contact: cloaked_fields has no FK to the
  -- polymorphic subject, and an orphaned ciphertext is unreachable forever.
  delete from public.cloaked_fields
   where subject_type = 'contact_group' and subject_id = p_group_id;

  -- Memberships cascade through the composite FK; the row itself goes last.
  delete from public.contact_groups where id = p_group_id;

  insert into public.audit_log (workspace_id, actor_id, action, subject_type, subject_id, detail)
  values (v_workspace_id, auth.uid(), 'group.delete', 'contact_group', p_group_id, '{}'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- add_group_member / remove_group_member — one RPC per checkbox
-- ---------------------------------------------------------------------------
create or replace function public.add_group_member(p_group_id uuid, p_contact_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_workspace_id uuid;
begin
  select workspace_id into v_workspace_id from public.contact_groups where id = p_group_id;
  if not found then
    raise exception 'group % does not exist', p_group_id
      using errcode = 'no_data_found', hint = 'group_not_found';
  end if;

  if not exists (select 1 from public.contacts where id = p_contact_id) then
    raise exception 'contact % does not exist', p_contact_id
      using errcode = 'no_data_found', hint = 'contact_not_found';
  end if;

  begin
    -- Idempotent: checking a checked box is not an error.
    insert into public.contact_group_members (group_id, contact_id, workspace_id)
    values (p_group_id, p_contact_id, v_workspace_id)
    on conflict (group_id, contact_id) do nothing;
  exception when foreign_key_violation then
    -- The composite FKs make cross-workspace membership unrepresentable (0016). Re-raised
    -- as a slug so the UI never shows a raw constraint name.
    raise exception 'group and contact belong to different workspaces'
      using errcode = 'foreign_key_violation', hint = 'cross_workspace';
  end;

  insert into public.audit_log (workspace_id, actor_id, action, subject_type, subject_id, detail)
  values (
    v_workspace_id, auth.uid(), 'group.member_add', 'contact_group', p_group_id, '{}'::jsonb
  );
end;
$$;

create or replace function public.remove_group_member(p_group_id uuid, p_contact_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_workspace_id uuid;
begin
  select workspace_id into v_workspace_id from public.contact_groups where id = p_group_id;
  if not found then
    raise exception 'group % does not exist', p_group_id
      using errcode = 'no_data_found', hint = 'group_not_found';
  end if;

  -- Unchecking an unchecked box is also not an error; the delete simply matches nothing.
  delete from public.contact_group_members
   where group_id = p_group_id and contact_id = p_contact_id;

  insert into public.audit_log (workspace_id, actor_id, action, subject_type, subject_id, detail)
  values (
    v_workspace_id, auth.uid(), 'group.member_remove', 'contact_group', p_group_id, '{}'::jsonb
  );
end;
$$;

-- BOTH revokes on every function, per 0017's closing note. The sweep in
-- security-posture.test.ts fails the build if any is forgotten.
revoke all     on function public.upsert_contact_group(uuid, uuid, integer, jsonb) from public, anon;
grant  execute on function public.upsert_contact_group(uuid, uuid, integer, jsonb) to authenticated;

revoke all     on function public.delete_contact_group(uuid) from public, anon;
grant  execute on function public.delete_contact_group(uuid) to authenticated;

revoke all     on function public.add_group_member(uuid, uuid) from public, anon;
grant  execute on function public.add_group_member(uuid, uuid) to authenticated;

revoke all     on function public.remove_group_member(uuid, uuid) from public, anon;
grant  execute on function public.remove_group_member(uuid, uuid) to authenticated;
