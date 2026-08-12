-- Writing contacts and visibility rules — the RPCs that make View As control something.
--
-- 0016 created the tables. Nothing has ever written to them, and `visibility_rules` has been
-- dead in BOTH directions since 0001 — never read, never written, not even seeded. Until this
-- migration, `apps/web/src/server/audience.ts` held two literal rules and four fictional
-- people, so View As demonstrated the engine rather than controlling anything.
--
-- ---------------------------------------------------------------------------
-- NO VERSION GUARD ON THESE, WHICH BREAKS THE HOUSE PATTERN ON PURPOSE
-- ---------------------------------------------------------------------------
--
-- Every event RPC takes `p_expected_version`, because two tabs editing one event is the
-- ordinary case and losing half an edit is real. A contact is one row that one person renames
-- occasionally; a rule is a row you overwrite wholesale by choosing a different option. There
-- is no partial state for a concurrent write to corrupt — last write wins IS the semantics.
--
-- Adding a version column so these could look like their siblings would be consistency for
-- its own sake, and it would put a "someone else changed this, reload" error in front of a
-- user who pressed a radio button twice.
--
-- ---------------------------------------------------------------------------
-- THE RULE WRITER IS AN UPSERT KEYED ON THE AUDIENCE, NOT AN INSERT
-- ---------------------------------------------------------------------------
--
-- "What can Sarah see" is one answer, not a growing list. If setting it twice left two rows,
-- the engine would resolve them by its tiebreak — which is defined and deterministic, and
-- would still mean the UI showed one setting while a shadow of the previous one sat behind
-- it. A partial unique index makes that unrepresentable rather than merely unlikely.

-- ---------------------------------------------------------------------------
-- One rule per (workspace, scope, event, audience, audience_ref)
--
-- `coalesce` on the nullable halves because NULL is not equal to itself in a unique index, so
-- without it every workspace-scoped rule (event_id NULL) would be distinct from every other.
-- ---------------------------------------------------------------------------
create unique index visibility_rules_one_per_audience
  on public.visibility_rules (
    workspace_id,
    scope,
    coalesce(event_id, '00000000-0000-0000-0000-000000000000'::uuid),
    audience,
    coalesce(audience_ref, '00000000-0000-0000-0000-000000000000'::uuid)
  );

-- ---------------------------------------------------------------------------
-- upsert_contact — create or rename, with the name sealed by the caller
-- ---------------------------------------------------------------------------
--
-- The id comes from the CLIENT, for the same reason it does on events: the AEAD binds
-- ciphertext to its subject id, so the caller must know the id BEFORE sealing. A
-- Postgres-generated id would produce a name nobody can ever decrypt.
create or replace function public.upsert_contact(
  p_contact_id   uuid,
  p_workspace_id uuid,
  -- [{ "field_name": "name", "ciphertext": "<hex>", "nonce": "<hex>", "alg": ..., "key_version": 1 }]
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
  insert into public.contacts (id, workspace_id)
  values (p_contact_id, p_workspace_id)
  on conflict (id) do update set updated_at = pg_catalog.now();

  for field in select * from jsonb_array_elements(p_fields)
  loop
    bytes := decode(field ->> 'ciphertext', 'hex');

    -- Same floor as events. AES-GCM output is at least its 16-byte tag; anything shorter is a
    -- client that skipped encryption, and catching it here means it cannot reach storage even
    -- once. A contact name in the clear would defeat the whole of ADR 0004.
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
      'contact', p_contact_id, p_workspace_id, field ->> 'field_name',
      bytes, decode(field ->> 'nonce', 'hex'),
      (field ->> 'alg')::public.cloak_alg,
      coalesce((field ->> 'key_version')::integer, 1)
    )
    -- Renaming replaces the sealed value. The unique key is (subject_type, subject_id,
    -- field_name), so without this a rename would collide rather than update.
    on conflict (subject_type, subject_id, field_name) do update
      set ciphertext = excluded.ciphertext,
          nonce      = excluded.nonce,
          alg        = excluded.alg,
          key_version = excluded.key_version;
  end loop;

  -- Metadata only. Recording WHICH contact by name would put in the audit log exactly the
  -- thing ADR 0004 took out of the contacts table.
  insert into public.audit_log (workspace_id, actor_id, action, subject_type, subject_id, detail)
  values (
    p_workspace_id, auth.uid(), 'contact.upsert', 'contact', p_contact_id,
    jsonb_build_object('fields_set', jsonb_array_length(p_fields))
  );

  return p_contact_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- delete_contact — and the rules that pointed at them
-- ---------------------------------------------------------------------------
create or replace function public.delete_contact(p_contact_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_workspace_id uuid;
begin
  select workspace_id into v_workspace_id from public.contacts where id = p_contact_id;
  if not found then
    raise exception 'contact % does not exist', p_contact_id
      using errcode = 'no_data_found', hint = 'contact_not_found';
  end if;

  -- `audience_ref` has no foreign key — it is polymorphic across contacts and groups, and
  -- Postgres has no polymorphic references — so nothing cascades. A rule left pointing at a
  -- deleted contact resolves to no match, which withholds rather than discloses, so this is
  -- tidiness rather than a safety fix. Doing it here anyway means the rules list cannot fill
  -- with entries naming people who no longer exist and cannot be identified.
  delete from public.visibility_rules
   where workspace_id = v_workspace_id
     and audience = 'individual'
     and audience_ref = p_contact_id;

  -- The sealed name is NOT cascaded by the database: cloaked_fields has no foreign key to
  -- contacts, because its subject is polymorphic too. Left behind it would be an orphaned
  -- ciphertext nobody can reach and nobody deletes.
  delete from public.cloaked_fields
   where subject_type = 'contact' and subject_id = p_contact_id;

  delete from public.contacts where id = p_contact_id;

  insert into public.audit_log (workspace_id, actor_id, action, subject_type, subject_id, detail)
  values (v_workspace_id, auth.uid(), 'contact.delete', 'contact', p_contact_id, '{}'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- set_visibility_rule — one answer per audience, overwritten in place
-- ---------------------------------------------------------------------------
create or replace function public.set_visibility_rule(
  p_workspace_id uuid,
  p_audience     text,
  p_audience_ref uuid,
  p_time_vis     text,
  p_fields       jsonb default '{}'::jsonb,
  -- Null for a workspace default; an event id for an override on one event.
  p_event_id     uuid  default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_scope    text := case when p_event_id is null then 'workspace' else 'event' end;
  v_priority integer;
  v_id       uuid;
begin
  if p_audience not in ('owner', 'individual', 'group', 'public') then
    raise exception 'unknown audience %', p_audience
      using errcode = 'check_violation', hint = 'unknown_audience';
  end if;
  if p_time_vis not in ('exact', 'busy', 'hidden') then
    raise exception 'unknown time visibility %', p_time_vis
      using errcode = 'check_violation', hint = 'unknown_time_visibility';
  end if;

  -- D8 breaks ties between group rules by priority, and the constraint on the table requires
  -- one for exactly the group case. Read from the group rather than accepted as a parameter:
  -- two rules disagreeing about one group's precedence would make the engine's answer depend
  -- on which rule was written last, which is the kind of nondeterminism that shows up as
  -- "sometimes she can see it".
  if p_audience = 'group' then
    select priority into v_priority from public.contact_groups where id = p_audience_ref;
    if not found then
      raise exception 'group % does not exist', p_audience_ref
        using errcode = 'no_data_found', hint = 'group_not_found';
    end if;
  end if;

  insert into public.visibility_rules (
    workspace_id, scope, event_id, audience, audience_ref, group_priority, time_vis, fields
  )
  values (
    p_workspace_id, v_scope, p_event_id, p_audience::public.audience_kind, p_audience_ref,
    v_priority, p_time_vis::public.time_visibility, p_fields
  )
  on conflict (
    workspace_id, scope,
    coalesce(event_id, '00000000-0000-0000-0000-000000000000'::uuid),
    audience,
    coalesce(audience_ref, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  do update set time_vis       = excluded.time_vis,
                fields         = excluded.fields,
                group_priority = excluded.group_priority,
                updated_at     = pg_catalog.now()
  returning id into v_id;

  -- The audience and the setting are Tier A — they are what the engine reasons about, and the
  -- server already holds them. What stays out is any hint of WHICH event, beyond its id.
  insert into public.audit_log (workspace_id, actor_id, action, subject_type, subject_id, detail)
  values (
    p_workspace_id, auth.uid(), 'visibility.set', 'visibility_rule', v_id,
    jsonb_build_object('scope', v_scope, 'audience', p_audience, 'time_vis', p_time_vis)
  );

  return v_id;
end;
$$;

create or replace function public.delete_visibility_rule(p_rule_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_workspace_id uuid;
begin
  select workspace_id into v_workspace_id from public.visibility_rules where id = p_rule_id;
  if not found then
    raise exception 'rule % does not exist', p_rule_id
      using errcode = 'no_data_found', hint = 'rule_not_found';
  end if;

  delete from public.visibility_rules where id = p_rule_id;

  insert into public.audit_log (workspace_id, actor_id, action, subject_type, subject_id, detail)
  values (v_workspace_id, auth.uid(), 'visibility.delete', 'visibility_rule', p_rule_id, '{}'::jsonb);
end;
$$;

-- BOTH revokes on every function. Supabase's default privileges grant EXECUTE to `anon`
-- outright, and Postgres separately grants it to PUBLIC at creation which `anon` inherits
-- through; revoking one leaves the other. security-posture.test.ts sweeps for this.
revoke all     on function public.upsert_contact(uuid, uuid, jsonb) from public, anon;
grant  execute on function public.upsert_contact(uuid, uuid, jsonb) to authenticated;

revoke all     on function public.delete_contact(uuid) from public, anon;
grant  execute on function public.delete_contact(uuid) to authenticated;

revoke all     on function public.set_visibility_rule(uuid, text, uuid, text, jsonb, uuid) from public, anon;
grant  execute on function public.set_visibility_rule(uuid, text, uuid, text, jsonb, uuid) to authenticated;

revoke all     on function public.delete_visibility_rule(uuid) from public, anon;
grant  execute on function public.delete_visibility_rule(uuid) to authenticated;
