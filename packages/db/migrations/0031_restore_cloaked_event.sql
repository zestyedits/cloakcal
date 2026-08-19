-- Undo, and the trash that makes it durable.
--
-- 0008 wrote, in its own header: "TRASH, NOT DELETE ... Cloaked fields are left alone on
-- purpose: deleting them here would make the trash one-way, which is not what a trash is."
-- That was true and nothing ever collected on it. `lifecycle = 'trashed'` and `trashed_at`
-- have been sitting on every deleted row since M4 with no way back, and `cancel_occurrence`
-- (0014) writes an exception row that nothing can remove. This migration is the other half.
--
-- Three functions, and they are three different acts:
--
--   restore_cloaked_event   a trashed row becomes active again. Touches no ciphertext.
--   uncancel_occurrence     a 'cancelled' exception row is removed. Touches no ciphertext.
--   purge_cloaked_event     the row and its ciphertext are actually destroyed.
--
-- ---------------------------------------------------------------------------
-- WHY THE VERSION PARAMETER IS NAMED FOR THE DELETE, NOT FOR THE ROW
-- ---------------------------------------------------------------------------
--
-- Every mutation in this schema takes `p_expected_version` — the version the caller believes
-- it is acting on. Undo cannot: the client holds the version it DELETED at, and the delete
-- incremented it. Asking for `version + 1` back would make every call site do arithmetic on
-- an invariant it cannot see, which is exactly how a `+ 1` rots silently.
--
-- So the parameter is `p_deleted_from_version` and the arithmetic lives here, once, where the
-- invariant it depends on is stated: trash_cloaked_event bumps `version` by EXACTLY ONE, and
-- a trashed row is then FROZEN — every mutation RPC refuses a non-active event — so `version
-- - 1` recovers the delete version from a plain read. packages/db pins the increment
-- separately, because if it ever bumped by two this file would refuse every legitimate
-- restore and the failure would read as a concurrency conflict rather than as arithmetic.
--
-- `uncancel_occurrence` takes no version at all, and the long comment above it explains why
-- that is a decision rather than an inconsistency: a series is not frozen, so the same trick
-- does not work, and there is nothing for a guard to protect anyway.
--
-- ---------------------------------------------------------------------------
-- WHAT PURGE MUST DELETE BY HAND, AND WHY THE CASCADE IS NOT ENOUGH
-- ---------------------------------------------------------------------------
--
-- `cloaked_fields` has NO foreign key to `events`. It is polymorphic — (subject_type,
-- subject_id) — and its only FK is workspace_id, so `delete from events` does not touch the
-- ciphertext at all. A purge written the obvious way would drop the row, satisfy every test,
-- and leave the encrypted title, location and notes in the database forever while the product
-- told the user they had been permanently removed. That is the erasure; everything else here
-- is metadata. packages/db asserts the ciphertext count is zero afterwards.
--
-- What the cascade DOES cover: `visibility_rules.event_id` and
-- `recurrence_exceptions.series_id` are both `on delete cascade`.
--
-- What survives, deliberately and unavoidably: `audit_log`. Its subject_id is a bare uuid
-- with no FK and the table carries `revoke update, delete` by design — it is append-only, so
-- nothing, including this function, can remove an entry. Those rows name no content: an id, a
-- timestamp, an action. The privacy policy states this rather than claiming a bare
-- "permanently deleted" it cannot honour.
--
-- ---------------------------------------------------------------------------
-- THE CONSTRAINT TRAP IN PURGE
-- ---------------------------------------------------------------------------
--
-- `recurrence_exceptions.replacement_event_id` is `on delete set null`, and the table also
-- carries `check ((kind = 'moved') = (replacement_event_id is not null))`. So purging an event
-- that a SPLIT detached from a series would null the pointer and then violate that check — the
-- delete fails, with an error about a constraint nobody was thinking about.
--
-- Deleting the exception row instead is worse than failing: the slot would return to the
-- series, so permanently deleting a detached occurrence would make it reappear on the
-- calendar. The subtraction has to survive its replacement. So the row is CONVERTED from
-- 'moved' to 'cancelled' and the pointer cleared, which satisfies the constraint in its
-- false = false branch and keeps the occurrence gone, which is what the user asked for.

-- ---------------------------------------------------------------------------

create or replace function public.restore_cloaked_event(
  p_event_id             uuid,
  p_deleted_from_version integer
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.events;
begin
  -- Read and lock first, so the three failure modes stay distinguishable and the version
  -- check cannot be split from the update. RLS applies, so a row in someone else's workspace
  -- is simply not found — indistinguishable from a bad id, which is the correct disclosure.
  select * into v_row from public.events where id = p_event_id for update;

  if not found then
    raise exception 'event % does not exist', p_event_id
      using errcode = 'no_data_found', hint = 'event_not_found';
  end if;

  -- Already back. Not an error worth raising on its own — but it must not be silent either,
  -- because the strip offering the undo would otherwise report success for a no-op and the
  -- user would have no idea a second tab had already done it.
  if v_row.lifecycle <> 'trashed' then
    raise exception 'event % is %, not trashed', p_event_id, v_row.lifecycle
      using errcode = 'object_not_in_prerequisite_state', hint = 'not_trashed';
  end if;

  if v_row.version <> p_deleted_from_version + 1 then
    raise exception
      'event % was changed after it was deleted (expected version %, found %)',
      p_event_id, p_deleted_from_version + 1, v_row.version
      using errcode = 'serialization_failure', hint = 'version_conflict';
  end if;

  update public.events
     set lifecycle  = 'active',
         trashed_at = null,
         version    = version + 1
   where id = p_event_id;

  -- Records THAT an event came back, and from which version. Never what it was: the title is
  -- ciphertext and the audit log is a Tier A surface.
  insert into public.audit_log (
    workspace_id, actor_id, action, subject_type, subject_id, detail
  )
  values (
    v_row.workspace_id, auth.uid(), 'event.restored', 'event', p_event_id,
    jsonb_build_object('from_version', p_deleted_from_version)
  );
end;
$$;

-- ---------------------------------------------------------------------------

-- NO VERSION GUARD ON THIS ONE, breaking the house pattern on purpose — the same call 0017
-- makes for visibility rules, and for a stronger reason.
--
-- A trashed EVENT is frozen: every mutation RPC refuses a non-active row, so its version is
-- reliably one past the delete and `restore_cloaked_event` can check it. A SERIES is not
-- frozen. Cancel two occurrences and the second bump makes the first one's delete version
-- unrecoverable from anything that only sees the row now — which is exactly the position the
-- Trash page is in. A guard that only the undo strip can satisfy is a guard that turns the
-- durable route into a permanent false conflict.
--
-- And there is nothing here for it to protect. This removes ONE row identified by
-- (series_id, occurrence_local); it cannot overwrite an edit, and if somebody already put the
-- occurrence back the row is gone and this raises `occurrence_not_cancelled`, which is the
-- honest and useful failure. A version check would add only conflicts invented from unrelated
-- edits to other occurrences.
create or replace function public.uncancel_occurrence(
  p_series_id        uuid,
  p_occurrence_local text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row        public.events;
  v_occurrence timestamp;
  v_existing   text;
begin
  select * into v_row from public.events where id = p_series_id for update;

  if not found then
    raise exception 'event % does not exist', p_series_id
      using errcode = 'no_data_found', hint = 'event_not_found';
  end if;

  -- Regex-validated before the cast, exactly as cancel_occurrence does: Postgres silently
  -- drops a timezone offset when parsing into `timestamp without time zone`, so a zoned
  -- string would un-cancel an occurrence hours away from the one the user is looking at,
  -- with no error anywhere. See the long comment above private.canonical_local in 0011.
  v_occurrence := private.canonical_local(p_occurrence_local);

  select kind into v_existing
    from public.recurrence_exceptions
   where series_id = p_series_id
     and occurrence_local = v_occurrence;

  if not found then
    raise exception 'occurrence % of event % is not cancelled', p_occurrence_local, p_series_id
      using errcode = 'object_not_in_prerequisite_state', hint = 'occurrence_not_cancelled';
  end if;

  -- A 'moved' exception is not a deletion and removing it would not restore anything — the
  -- occurrence already exists, as its own event row, put there by a split. Undoing THAT is a
  -- different action on a different id, and conflating the two would silently duplicate the
  -- occurrence: once in the series, once as the detached row.
  if v_existing <> 'cancelled' then
    raise exception
      'occurrence % of event % was moved to its own event, not deleted',
      p_occurrence_local, p_series_id
      using errcode = 'check_violation', hint = 'occurrence_detached';
  end if;

  delete from public.recurrence_exceptions
   where series_id = p_series_id
     and occurrence_local = v_occurrence;

  update public.events
     set version = version + 1
   where id = p_series_id;

  insert into public.audit_log (
    workspace_id, actor_id, action, subject_type, subject_id, detail
  )
  values (
    v_row.workspace_id, auth.uid(), 'event.occurrence_uncancelled', 'event', p_series_id,
    jsonb_build_object(
      'occurrence_local', p_occurrence_local,
      'from_version', v_row.version
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------

create or replace function public.purge_cloaked_event(
  p_event_id uuid
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.events;
begin
  select * into v_row from public.events where id = p_event_id for update;

  if not found then
    raise exception 'event % does not exist', p_event_id
      using errcode = 'no_data_found', hint = 'event_not_found';
  end if;

  -- NO VERSION GUARD, and that is a decision rather than an omission. The guard exists to
  -- stop you acting on a row that moved under you, and `lifecycle = 'trashed'` already answers
  -- the only version of that question which matters here: if someone restored this event in
  -- another tab, it is active and this refuses. A version check on top would additionally
  -- refuse an event that was merely edited before being trashed, which is not a conflict —
  -- it is an old event the user is now certain about.
  if v_row.lifecycle <> 'trashed' then
    raise exception 'event % is %, so it cannot be permanently deleted', p_event_id, v_row.lifecycle
      using errcode = 'object_not_in_prerequisite_state', hint = 'purge_requires_trashed';
  end if;

  -- See the header. `recurrence_exceptions.replacement_event_id` is `on delete set null` and
  -- the table checks `(kind = 'moved') = (replacement_event_id is not null)`, so the delete
  -- below would violate that check for any occurrence a split detached into THIS event.
  -- Converting rather than deleting keeps the occurrence subtracted from its series, which is
  -- what permanently deleting a detached occurrence has to mean.
  update public.recurrence_exceptions
     set kind = 'cancelled',
         replacement_event_id = null
   where replacement_event_id = p_event_id;

  -- THE ACTUAL ERASURE. There is no foreign key from cloaked_fields to events — the table is
  -- polymorphic on (subject_type, subject_id) — so nothing else in this statement or in any
  -- cascade would remove the ciphertext. Deleted first, so a failure here aborts before the
  -- row that points at it is gone.
  delete from public.cloaked_fields
   where subject_type = 'event'
     and subject_id = p_event_id;

  -- visibility_rules (event_id) and recurrence_exceptions (series_id) both cascade from here.
  delete from public.events where id = p_event_id;

  -- The audit row is written and then CANNOT BE REMOVED, by this function or any other: the
  -- table is append-only (revoke update, delete). It names an id and an action and no content
  -- of any kind, and the privacy policy says so rather than claiming an erasure this schema
  -- deliberately does not perform.
  insert into public.audit_log (
    workspace_id, actor_id, action, subject_type, subject_id, detail
  )
  values (
    v_row.workspace_id, auth.uid(), 'event.purged', 'event', p_event_id,
    jsonb_build_object('from_version', v_row.version)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- BOTH revokes are required on every function, and neither is redundant. Supabase's default
-- privileges grant EXECUTE to `anon` outright, and Postgres separately grants it to PUBLIC on
-- every function at creation, which `anon` inherits through. Revoking one leaves the other.
-- The sweep in packages/db/test/security-posture.test.ts fails if any function in `public` is
-- executable by `anon`; trust it rather than reasoning about grants.

revoke all     on function public.restore_cloaked_event(uuid, integer) from public, anon;
grant  execute on function public.restore_cloaked_event(uuid, integer) to authenticated;

revoke all     on function public.uncancel_occurrence(uuid, text) from public, anon;
grant  execute on function public.uncancel_occurrence(uuid, text) to authenticated;

revoke all     on function public.purge_cloaked_event(uuid) from public, anon;
grant  execute on function public.purge_cloaked_event(uuid) to authenticated;
