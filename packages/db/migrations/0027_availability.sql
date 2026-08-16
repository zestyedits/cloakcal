-- Weekly availability: the hours you are open, per weekday.
--
-- The first piece of booking that exists, and it is deliberately the piece that is useful on
-- its own: the calendar shades the hours outside your availability, so this is a real setting
-- from the day it ships rather than a form that stores something for a feature nobody can use
-- yet. This project already deleted a "Coming soon" card for wearing the same weight as cards
-- that work; a settings page whose only honest state is "this does nothing" is that mistake
-- with a table behind it.
--
-- THESE ARE WALL-CLOCK TIMES, NOT INSTANTS, and that is the same law recurrence follows
-- (docs/decisions/0001-recurrence-dst.md). "09:00 on Tuesday" means 09:00 local, and it stays
-- 09:00 across a DST shift. That is why the columns are MINUTES PAST LOCAL MIDNIGHT and not
-- `time with time zone`, and why nothing downstream may wrap one of these in `new Date()` —
-- doing so reintroduces the host timezone and silently moves somebody's working day.
--
-- TIER A, AND HERE IS WHY THAT IS ALLOWED. This is stored in the clear and the server can
-- read it. It is the same class of fact as event times, which have been plaintext since 0001
-- under plan D1 because booking, reminders and conflict detection need them, and it reveals
-- strictly LESS than `events` already does: "this person works Tuesdays 9 to 5" against a row
-- that already says they are busy 10 to 11 on a specific Tuesday. No content, no ciphertext,
-- nothing an audience could be shown more or less of. Rule 5 is untouched.
--
-- WEEKDAY IS 0 = SUNDAY, matching `workspaces.week_start` (0018) rather than ISO's 1 = Monday.
-- One convention per codebase; the domain package's Temporal code uses ISO and converts at its
-- own boundary, which is one documented conversion instead of two conventions in the schema.
--
-- NO ROWS MEANS NOT SET, not "unavailable". Absence is the same trick 0024 uses for the plan:
-- it needs no bootstrap insert, cannot race anything, and fails in the harmless direction —
-- a workspace with no availability shades nothing, rather than shading everything and making
-- the calendar look broken on day one.

create table public.availability_windows (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null
    references public.workspaces (id) on delete cascade,
  weekday      smallint not null
    constraint availability_weekday_range check (weekday between 0 and 6),
  -- Minutes past local midnight. 1440 is allowed as an END so a window can run to midnight;
  -- it is not allowed as a START, which the ordering constraint below already implies.
  start_minute smallint not null
    constraint availability_start_range check (start_minute between 0 and 1439),
  end_minute   smallint not null
    constraint availability_end_range check (end_minute between 1 and 1440),
  constraint availability_window_ordered check (end_minute > start_minute),
  created_at   timestamptz not null default now()
);

comment on table public.availability_windows is
  'Weekly availability in LOCAL wall-clock minutes past midnight. Tier A: times only, never content. No rows means not set, not unavailable.';
comment on column public.availability_windows.weekday is
  '0 = Sunday, matching workspaces.week_start.';

create index availability_windows_workspace_idx
  on public.availability_windows (workspace_id, weekday, start_minute);

alter table public.availability_windows enable row level security;
alter table public.availability_windows force row level security;

-- RLS is COARSE ROW AUTHORISATION, exactly as rule 3 says: these four policies answer "is
-- this your workspace", and nothing else.
--
-- All four verbs, not SELECT alone, and it is worth being clear about why rather than
-- pretending the RPC is a gate it cannot be. `set_availability` is SECURITY INVOKER, so it
-- runs with the CALLER's privileges — if `authenticated` cannot insert, neither can the
-- function. SECURITY DEFINER would let the function hold privileges the caller lacks and is
-- banned outright by security-posture.test.ts, for good reasons that have nothing to do with
-- this table. So the caller holds the privileges, and a determined client can write rows
-- directly through PostgREST.
--
-- WHAT THAT COSTS, honestly: the no-overlap rule below is a DATA HYGIENE invariant enforced
-- in the RPC, not a security boundary. Someone bypassing the RPC can store overlapping
-- windows in their own workspace. The consequence is two bands of shading on their own
-- calendar. It is their data, they cannot reach anyone else's, and nothing downstream may
-- assume non-overlap — the read path merges windows rather than trusting them.
create policy availability_select on public.availability_windows
  for select to authenticated
  using (private.is_workspace_member(workspace_id));

create policy availability_insert on public.availability_windows
  for insert to authenticated
  with check (private.is_workspace_member(workspace_id));

create policy availability_update on public.availability_windows
  for update to authenticated
  using (private.is_workspace_member(workspace_id))
  with check (private.is_workspace_member(workspace_id));

create policy availability_delete on public.availability_windows
  for delete to authenticated
  using (private.is_workspace_member(workspace_id));

-- Allowlist, not a subtraction. 0024 wrote its revoke this way and that is how the TRUNCATE
-- hole surfaced: naming the verbs you thought of cannot survive a verb you have not heard of,
-- and MAINTAIN arrived in PostgreSQL 17 pre-granted. The four DML verbs are the ones RLS
-- actually mediates; nothing else is granted.
revoke all on public.availability_windows from anon, authenticated, public;
grant select, insert, update, delete on public.availability_windows to authenticated;

/*
 * Replace the whole week, in one transaction.
 *
 * REPLACE-ALL IS THE SEMANTICS, not a shortcut. A schedule is edited as a whole — you drag
 * Tuesday, you add a second window on Monday, you clear Friday — so "here is the new week" is
 * what the user actually did, and it makes overlap checkable in one place with all the rows
 * in hand. Per-row upserts would need a version guard per window and would still not be able
 * to answer "does this overlap anything else".
 *
 * NO VERSION GUARD, which breaks the house RPC pattern on purpose and for the same reason
 * `visibility_rules` does (ADR 0004): last-write-wins IS the semantics here, and a version
 * column would put "someone else changed this, reload" in front of somebody double-clicking
 * their own Save button.
 */
create or replace function public.set_availability(
  p_workspace_id uuid,
  -- [{ "weekday": 1, "start_minute": 540, "end_minute": 1020 }, ...]
  p_windows      jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  window_row   jsonb;
  weekday      integer;
  starts       integer;
  ends         integer;
  -- Scalars rather than a `record`: an unassigned plpgsql record cannot be tested with
  -- `is not null` at all, it raises "record is not assigned yet" the first time round the
  -- loop. Two integers say the same thing and can start as null.
  prev_weekday integer := null;
  prev_end     integer := null;
begin
  if jsonb_typeof(p_windows) <> 'array' then
    raise exception 'windows must be a json array'
      using errcode = 'invalid_parameter_value', hint = 'windows_not_array';
  end if;

  -- Prove the workspace is reachable BEFORE deleting anything. Without this, a caller
  -- pointing at someone else's workspace would delete nothing, insert nothing and be told
  -- everything went fine.
  perform 1 from public.workspaces where id = p_workspace_id;
  if not found then
    raise exception 'workspace % does not exist', p_workspace_id
      using errcode = 'no_data_found', hint = 'workspace_not_found';
  end if;

  for window_row in select * from jsonb_array_elements(p_windows)
  loop
    weekday := (window_row ->> 'weekday')::integer;
    starts  := (window_row ->> 'start_minute')::integer;
    ends    := (window_row ->> 'end_minute')::integer;

    if weekday is null or starts is null or ends is null then
      raise exception 'a window is missing weekday, start_minute or end_minute'
        using errcode = 'invalid_parameter_value', hint = 'window_incomplete';
    end if;
    if weekday < 0 or weekday > 6 then
      raise exception 'weekday % is not a weekday index', weekday
        using errcode = 'check_violation', hint = 'invalid_weekday';
    end if;
    if starts < 0 or starts > 1439 or ends < 1 or ends > 1440 then
      raise exception 'a window falls outside the day'
        using errcode = 'check_violation', hint = 'window_outside_day';
    end if;
    if ends <= starts then
      raise exception 'a window ends before it starts'
        using errcode = 'check_violation', hint = 'window_ends_before_start';
    end if;
  end loop;

  /*
   * OVERLAP, checked here rather than by an exclusion constraint.
   *
   * `EXCLUDE USING gist` would be the textbook answer and it needs btree_gist, which is an
   * extension this schema does not install and which the PGlite harness would have to match.
   * A sorted scan over one workspace's week is a handful of rows and needs nothing.
   *
   * It runs on a temp view of the INCOMING set, before the delete, so a rejected save leaves
   * the stored week untouched rather than half-applied.
   */
  for window_row in
    select value
      from jsonb_array_elements(p_windows) as value
     order by (value ->> 'weekday')::integer, (value ->> 'start_minute')::integer
  loop
    weekday := (window_row ->> 'weekday')::integer;
    starts  := (window_row ->> 'start_minute')::integer;
    ends    := (window_row ->> 'end_minute')::integer;

    -- `starts < prev_end`, deliberately not `<=`: 12:00-13:00 followed by 13:00-17:00 is a
    -- lunch break written as two windows, not an overlap.
    if prev_weekday is not null and prev_weekday = weekday and starts < prev_end then
      raise exception 'two windows overlap on weekday %', weekday
        using errcode = 'check_violation', hint = 'windows_overlap';
    end if;

    prev_weekday := weekday;
    prev_end := ends;
  end loop;

  delete from public.availability_windows where workspace_id = p_workspace_id;

  insert into public.availability_windows (workspace_id, weekday, start_minute, end_minute)
  select
    p_workspace_id,
    (value ->> 'weekday')::smallint,
    (value ->> 'start_minute')::smallint,
    (value ->> 'end_minute')::smallint
  from jsonb_array_elements(p_windows) as value;

  -- HOW MANY windows, never which hours: the audit log records that a setting moved, and the
  -- values are already readable in the table to anyone the policy admits.
  insert into public.audit_log (workspace_id, actor_id, action, subject_type, subject_id, detail)
  values (
    p_workspace_id, auth.uid(), 'workspace.availability', 'workspace', p_workspace_id,
    jsonb_build_object('windows', jsonb_array_length(p_windows))
  );
end;
$$;

-- BOTH revokes, per 0017's closing note: Supabase's default privileges grant EXECUTE to
-- `anon` outright, and Postgres separately grants it to PUBLIC at creation. The sweep in
-- security-posture.test.ts fails the build if either is forgotten.
revoke all     on function public.set_availability(uuid, jsonb) from public, anon;
grant  execute on function public.set_availability(uuid, jsonb) to authenticated;
