-- Give trash_cloaked_event the same error slugs update_cloaked_event has.
--
-- WHY. delete-event.tsx discriminates its three failure modes by regex-matching the
-- exception's MESSAGE TEXT. That works, and it quietly makes prose an interface: rewording a
-- `raise exception` for clarity would degrade a careful user-facing message into a raw
-- database string, and nothing would fail to warn you.
--
-- 0011 established the fix — a stable slug in the exception HINT, which PostgREST passes
-- through untouched — and this brings the delete path onto it before a second consumer
-- copies the old habit. Behaviour is otherwise identical: same checks, same order, same
-- messages, same SQLSTATEs.

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
      using errcode = 'no_data_found', hint = 'event_not_found';
  end if;

  if v_lifecycle <> 'active' then
    raise exception 'event % is already %', p_event_id, v_lifecycle
      using errcode = 'object_not_in_prerequisite_state', hint = 'event_trashed';
  end if;

  if v_version <> p_expected_version then
    raise exception
      'event % was changed by someone else (expected version %, found %)',
      p_event_id, p_expected_version, v_version
      using errcode = 'serialization_failure', hint = 'version_conflict';
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
      using errcode = 'serialization_failure', hint = 'version_conflict';
  end if;

  insert into public.audit_log (
    workspace_id, actor_id, action, subject_type, subject_id, detail
  )
  values (
    v_workspace_id, auth.uid(), 'event.trashed', 'event', p_event_id,
    jsonb_build_object('from_version', p_expected_version)
  );
end;
$$;

revoke all     on function public.trash_cloaked_event(uuid, integer) from public, anon;
grant  execute on function public.trash_cloaked_event(uuid, integer) to authenticated;
