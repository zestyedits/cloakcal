-- CloakCal Phase 1 — Row Level Security
--
-- SCOPE OF THIS FILE (D2): RLS is COARSE AUTHORISATION ONLY.
--   It answers "may this user touch this row at all?" — workspace/ownership boundaries.
--   It NEVER decides field-level visibility. That is packages/policy's sole job.
--   If you find yourself writing a policy that inspects `fields` or reasons about an
--   audience, stop: that logic belongs in the policy engine, not here.
--
-- Phase 1 is single-owner (Private Personal Calendar), so every policy reduces to
-- "the caller owns the workspace". Sharing and teams extend is_workspace_member()
-- later without rewriting per-table policies — which is exactly why the ownership
-- test is centralised in one function.

-- ---------------------------------------------------------------------------
-- Membership helper
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER with a pinned search_path: the function must not be hijackable by a
-- caller-controlled search_path, and it must be able to read workspaces without
-- recursively triggering the workspaces policy that calls it.

create or replace function public.is_workspace_member(ws uuid)
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

revoke all on function public.is_workspace_member(uuid) from public;
grant execute on function public.is_workspace_member(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere. No table in `public` may be left unprotected.
-- packages/db/test/rls.test.ts asserts this table-by-table, so a future migration
-- that adds a table without RLS fails CI rather than leaking silently.
-- ---------------------------------------------------------------------------

alter table public.profiles          enable row level security;
alter table public.workspaces        enable row level security;
alter table public.calendars         enable row level security;
alter table public.events            enable row level security;
alter table public.cloaked_fields    enable row level security;
alter table public.visibility_rules  enable row level security;
alter table public.presets           enable row level security;
alter table public.devices           enable row level security;
alter table public.access_envelopes  enable row level security;
alter table public.applied_ops       enable row level security;
alter table public.audit_log         enable row level security;

-- Force RLS even for the table owner, so a mistakenly-privileged connection
-- does not bypass the boundary.
alter table public.profiles          force row level security;
alter table public.workspaces        force row level security;
alter table public.calendars         force row level security;
alter table public.events            force row level security;
alter table public.cloaked_fields    force row level security;
alter table public.visibility_rules  force row level security;
alter table public.presets           force row level security;
alter table public.devices           force row level security;
alter table public.access_envelopes  force row level security;
alter table public.applied_ops       force row level security;
alter table public.audit_log         force row level security;

-- ---------------------------------------------------------------------------
-- profiles — a user sees only their own row
-- ---------------------------------------------------------------------------

create policy profiles_select on public.profiles
  for select to authenticated using (id = auth.uid());
create policy profiles_insert on public.profiles
  for insert to authenticated with check (id = auth.uid());
create policy profiles_update on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- ---------------------------------------------------------------------------
-- workspaces — owner only
-- ---------------------------------------------------------------------------

create policy workspaces_select on public.workspaces
  for select to authenticated using (owner_id = auth.uid());
create policy workspaces_insert on public.workspaces
  for insert to authenticated with check (owner_id = auth.uid());
create policy workspaces_update on public.workspaces
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy workspaces_delete on public.workspaces
  for delete to authenticated using (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Workspace-scoped tables — identical shape, delegated to is_workspace_member().
--
-- USING and WITH CHECK are both required on update: USING controls which rows you may
-- read-modify, WITH CHECK controls what the row may become. Omitting WITH CHECK would
-- let a caller move a row into someone else's workspace — a cross-workspace write,
-- which is precisely the boundary violation Spec §3 calls a real boundary.
-- ---------------------------------------------------------------------------

create policy calendars_all on public.calendars
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

create policy events_all on public.events
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id) and owner_id = auth.uid());

create policy cloaked_fields_all on public.cloaked_fields
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

create policy visibility_rules_all on public.visibility_rules
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

create policy presets_all on public.presets
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

create policy access_envelopes_all on public.access_envelopes
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- ---------------------------------------------------------------------------
-- User-scoped tables
-- ---------------------------------------------------------------------------

create policy devices_all on public.devices
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy applied_ops_all on public.applied_ops
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- audit_log — append-only from the user's perspective.
-- Readable by the workspace owner (Spec §3 requires visible activity history);
-- deliberately has NO update or delete policy, so history cannot be rewritten
-- or quietly erased by the account holder.
-- ---------------------------------------------------------------------------

create policy audit_log_select on public.audit_log
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy audit_log_insert on public.audit_log
  for insert to authenticated
  with check (public.is_workspace_member(workspace_id) and actor_id = auth.uid());

-- Defense in depth. Omitting UPDATE/DELETE policies already yields zero affected rows,
-- but that is denial by *omission*: a future migration that adds a permissive policy
-- would silently open the door. Revoking the table privilege outright means such a
-- mistake still fails with "permission denied" rather than quietly succeeding.
revoke update, delete on public.audit_log from authenticated;
