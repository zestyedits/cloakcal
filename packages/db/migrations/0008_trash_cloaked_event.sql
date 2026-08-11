-- M4 — moving an event to the trash from the browser.
--
-- This is the second half of the smallest useful CRUD loop: until now you could create an
-- event and never get rid of it. It is deliberately the SIMPLEST mutation to port from
-- packages/db first — one row, one state change, no recurrence planning — so the RPC shape
-- (version guard, audit, invoker rights) gets settled here before the harder series edits
-- are written against it.
--
-- SECURITY INVOKER, for the same reason as create_cloaked_event: the function runs as the
-- caller, so RLS decides which rows are even visible. A definer-rights version would let any
-- authenticated user trash any event id they could guess.
--
-- TRASH, NOT DELETE. `lifecycle` moves to 'trashed' and the row stays. Purge is a separate,
-- explicit action, and the read path already filters on lifecycle = 'active' so a trashed
-- event disappears from the calendar immediately. Cloaked fields are left alone on purpose:
-- deleting them here would make the trash one-way, which is not what a trash is.
--
-- OPTIMISTIC CONCURRENCY. The caller passes the version it believes it is deleting. This
-- mirrors gate 2 of packages/db/src/events.ts, and it matters more than it looks: two tabs
-- open on the same calendar is the normal case, not the exotic one, and without the guard
-- the second tab silently trashes an event the user has since edited elsewhere.

create or replace function public.trash_cloaked_event(
  p_event_id         uuid,
  p_expected_version integer
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_version      integer;
  v_lifecycle    public.lifecycle_state;
begin
  -- Read first so the three failure modes can be told apart. A bare guarded UPDATE that
  -- matched nothing would collapse "does not exist", "already trashed" and "someone else
  -- changed it" into one indistinguishable no-op, and the UI needs to say which.
  --
  -- RLS applies to this select, so a row in someone else's workspace is simply not found —
  -- the caller cannot distinguish it from a bad id, which is the correct disclosure.
  select workspace_id, version, lifecycle
    into v_workspace_id, v_version, v_lifecycle
    from public.events
   where id = p_event_id;

  if not found then
    raise exception 'event % does not exist', p_event_id
      using errcode = 'no_data_found';
  end if;

  if v_lifecycle <> 'active' then
    raise exception 'event % is already %', p_event_id, v_lifecycle
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if v_version <> p_expected_version then
    raise exception
      'event % was changed by someone else (expected version %, found %)',
      p_event_id, p_expected_version, v_version
      using errcode = 'serialization_failure';
  end if;

  update public.events
     set lifecycle  = 'trashed',
         trashed_at = pg_catalog.now(),
         version    = version + 1
   where id      = p_event_id
     and version = p_expected_version
     and lifecycle = 'active';

  -- Re-checked rather than assumed. The select above is not a lock, so a concurrent writer
  -- can land between the two statements; this turns that race into the same honest conflict
  -- the version check reports rather than a silent no-op.
  if not found then
    raise exception 'event % was changed by someone else while being deleted', p_event_id
      using errcode = 'serialization_failure';
  end if;

  -- Metadata only. Naming the event here would undo the encryption the audit log exists to
  -- record against.
  insert into public.audit_log (
    workspace_id, actor_id, action, subject_type, subject_id, detail
  )
  values (
    v_workspace_id, auth.uid(), 'event.trashed', 'event', p_event_id,
    jsonb_build_object('from_version', p_expected_version)
  );
end;
$$;

revoke all     on function public.trash_cloaked_event(uuid, integer) from public;
grant  execute on function public.trash_cloaked_event(uuid, integer) to authenticated;
