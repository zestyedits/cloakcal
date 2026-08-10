-- Move the RLS membership helper out of the PostgREST-exposed API surface.
--
-- WHY: Supabase exposes every function in `public` as an RPC endpoint
-- (/rest/v1/rpc/<name>). is_workspace_member is SECURITY DEFINER — it runs with the
-- definer's privileges by design, so that a policy can read public.workspaces without
-- recursing into the workspaces policy that calls it. A definer-rights function that is
-- also a public HTTP endpoint is the wrong shape, flagged by the Supabase security
-- advisor as lints 0028 and 0029.
--
-- WHY NOT JUST REVOKE EXECUTE: RLS policy expressions are evaluated with the *calling*
-- user's privileges. Revoking EXECUTE from `authenticated` would not harden the policy,
-- it would break every query against every workspace-scoped table with "permission
-- denied for function". The function must remain executable by the caller; it simply
-- must not live in an exposed schema.

create schema if not exists private;

revoke all on schema private from public;
grant usage on schema private to authenticated;

create or replace function private.is_workspace_member(ws uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.workspaces w
    where w.id = ws
      and w.owner_id = auth.uid()
      and w.lifecycle <> 'purged'
  );
$$;

revoke all on function private.is_workspace_member(uuid) from public;
grant execute on function private.is_workspace_member(uuid) to authenticated;

-- Repoint every policy before the old function can be dropped: Postgres refuses to drop
-- a function that a live policy still depends on, which is a useful safety net here.

alter policy calendars_all on public.calendars
  using (private.is_workspace_member(workspace_id))
  with check (private.is_workspace_member(workspace_id));

alter policy events_all on public.events
  using (private.is_workspace_member(workspace_id))
  with check (private.is_workspace_member(workspace_id) and owner_id = auth.uid());

alter policy cloaked_fields_all on public.cloaked_fields
  using (private.is_workspace_member(workspace_id))
  with check (private.is_workspace_member(workspace_id));

alter policy visibility_rules_all on public.visibility_rules
  using (private.is_workspace_member(workspace_id))
  with check (private.is_workspace_member(workspace_id));

alter policy presets_all on public.presets
  using (private.is_workspace_member(workspace_id))
  with check (private.is_workspace_member(workspace_id));

alter policy access_envelopes_all on public.access_envelopes
  using (private.is_workspace_member(workspace_id))
  with check (private.is_workspace_member(workspace_id));

alter policy audit_log_select on public.audit_log
  using (private.is_workspace_member(workspace_id));

alter policy audit_log_insert on public.audit_log
  with check (private.is_workspace_member(workspace_id) and actor_id = auth.uid());

drop function public.is_workspace_member(uuid);
