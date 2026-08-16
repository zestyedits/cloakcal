-- One more workspace preference: which country's public holidays the calendar draws.
--
-- A column on `workspaces` beside timezone, week_start, default_view and keyboard_shortcuts,
-- for the reason 0022 gives: display framing has lived there since 0001 and a second home for
-- the same kind of fact is how the two disagree.
--
-- THIS IS TIER A, AND IT IS WORTH SAYING WHY IT IS ALLOWED TO BE. The column stores a country
-- code, in the clear, readable by the server. That is the same class of fact as `timezone`,
-- which has been plaintext since 0001 and is strictly MORE identifying — 'America/Toronto'
-- already narrows a person further than 'CA' does. Rule 1 is the standard here: the server
-- holds framing, never content, and says so plainly. Nothing about an event is involved.
--
-- WHY ONE COLUMN AND NOT A BOOLEAN PLUS A REGION. Three states in one value:
--   'auto'  — follow the timezone; render nothing if it maps to no region we ship
--   'off'   — the user said no
--   a code  — the user said which, and it outranks the timezone
-- A boolean beside a nullable region can represent "enabled with no region" and "disabled,
-- region US", two states that mean nothing and that every reader downstream would then have
-- to decide about independently. Same argument as 0024's "absence means Free": make the bad
-- state unrepresentable instead of handling it in four places.
--
-- DEFAULT 'auto', which turns holidays ON for existing rows. That is the intended migration
-- behaviour, not an oversight. The feature's whole value is being there without being asked
-- for, it is switched off from the sidebar in one click, and the fail-direction is benign —
-- the worst case is a public date on screen that the user did not want, which is the opposite
-- of the fail-direction this project usually guards (nothing here can leak, because none of
-- it is the user's data in the first place).
--
-- THE REGION LIST IS DUPLICATED between this CHECK and HOLIDAY_REGIONS in
-- packages/domain/src/holidays.ts, and that duplication is deliberate rather than missed. The
-- database is the last line that stops a junk value being stored, and it cannot import
-- TypeScript. `holiday-prefs.test.ts` asserts the two lists agree, which is the same shape as
-- the policy engine's contract test: two implementations, one pinned assertion, no drift.

alter table public.workspaces
  add column holiday_region text not null default 'auto'
    constraint workspaces_holiday_region_known
    check (holiday_region in ('auto', 'off', 'US', 'GB', 'CA', 'AU', 'IE', 'NZ'));

comment on column public.workspaces.holiday_region is
  'Which country''s public holidays the calendar draws. auto follows the timezone, off draws none. Display framing only (Tier A), never event content.';

create or replace function public.set_workspace_prefs(
  p_workspace_id       uuid,
  -- Null means "leave unchanged", so one RPC serves every control in the section without
  -- each write racing the others' reads.
  p_timezone           text    default null,
  p_week_start         integer default null,
  p_default_view       text    default null,
  p_keyboard_shortcuts boolean default null,
  p_holiday_region     text    default null
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_week_start is not null and (p_week_start < 0 or p_week_start > 6) then
    raise exception 'week_start % is not a weekday index', p_week_start
      using errcode = 'check_violation', hint = 'invalid_week_start';
  end if;

  -- Same shape rule as the column constraint, raised here so the caller gets a slug
  -- instead of a constraint name.
  if p_timezone is not null
     and (p_timezone !~ '^[A-Za-z_][A-Za-z0-9_+\-]*(/[A-Za-z0-9_+\-]+){0,2}$'
          or length(p_timezone) > 64) then
    raise exception 'timezone % does not look like an IANA zone name', p_timezone
      using errcode = 'check_violation', hint = 'unknown_timezone';
  end if;

  if p_default_view is not null
     and p_default_view not in ('agenda', 'week', 'day', 'month') then
    raise exception '% is not a calendar view', p_default_view
      using errcode = 'check_violation', hint = 'unknown_view';
  end if;

  if p_holiday_region is not null
     and p_holiday_region not in ('auto', 'off', 'US', 'GB', 'CA', 'AU', 'IE', 'NZ') then
    raise exception '% is not a holiday region', p_holiday_region
      using errcode = 'check_violation', hint = 'unknown_holiday_region';
  end if;

  update public.workspaces
     set timezone           = coalesce(p_timezone, timezone),
         week_start         = coalesce(p_week_start::smallint, week_start),
         default_view       = coalesce(p_default_view, default_view),
         keyboard_shortcuts = coalesce(p_keyboard_shortcuts, keyboard_shortcuts),
         holiday_region     = coalesce(p_holiday_region, holiday_region)
   where id = p_workspace_id;

  -- RLS makes someone else's workspace indistinguishable from a missing one, which is the
  -- correct amount of information to give.
  if not found then
    raise exception 'workspace % does not exist', p_workspace_id
      using errcode = 'no_data_found', hint = 'workspace_not_found';
  end if;

  -- Which prefs changed is Tier A; the values are the server's own framing data.
  insert into public.audit_log (workspace_id, actor_id, action, subject_type, subject_id, detail)
  values (
    p_workspace_id, auth.uid(), 'workspace.prefs', 'workspace', p_workspace_id,
    jsonb_strip_nulls(jsonb_build_object(
      'timezone', p_timezone,
      'week_start', p_week_start,
      'default_view', p_default_view,
      'keyboard_shortcuts', p_keyboard_shortcuts,
      'holiday_region', p_holiday_region
    ))
  );
end;
$$;

-- The five-parameter signature is a DIFFERENT function to Postgres and would linger callable
-- beside the new one, still writing four of the five preferences. 0022 dropped its
-- predecessor for the same reason.
drop function if exists public.set_workspace_prefs(uuid, text, integer, text, boolean);

-- BOTH revokes, per 0017's closing note: Supabase's default privileges grant EXECUTE to
-- `anon` outright, and Postgres separately grants it to PUBLIC at creation. The sweep in
-- security-posture.test.ts fails the build if either is forgotten.
revoke all     on function public.set_workspace_prefs(uuid, text, integer, text, boolean, text) from public, anon;
grant  execute on function public.set_workspace_prefs(uuid, text, integer, text, boolean, text) to authenticated;
