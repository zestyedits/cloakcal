-- Two more workspace preferences: which view the home page opens on, and whether the
-- single-key shortcuts are live.
--
-- Columns on `workspaces` rather than a prefs table, because that is where timezone and
-- week_start have lived since 0001 and a second home for the same kind of fact is how the
-- two disagree. Extends set_workspace_prefs in place: null still means "leave unchanged",
-- so the settings card's controls keep writing independently without racing each other's
-- reads.
--
-- keyboard_shortcuts DEFAULTS TO FALSE, and that is a compliance decision, not a style
-- one. WCAG 2.1.4 offers exactly three routes for single-key shortcuts: a way to turn
-- them off, remapping onto a modifier, or active-only-on-focus. Off-by-default behind a
-- settings toggle is route one, and it is what Google Calendar ships. Ignoring keys while
-- an input has focus - which the client also does - is necessary but is NOT one of the
-- three routes. Flipping this default to true would reopen the gap.

alter table public.workspaces
  add column default_view text not null default 'agenda'
    constraint workspaces_default_view_known
    check (default_view in ('agenda', 'week', 'day', 'month')),
  add column keyboard_shortcuts boolean not null default false;

comment on column public.workspaces.default_view is
  'The calendar view / opens on when the URL names none. ?view= always wins.';
comment on column public.workspaces.keyboard_shortcuts is
  'Single-key shortcuts are opt-in (WCAG 2.1.4 route one). Off until the user turns them on.';

create or replace function public.set_workspace_prefs(
  p_workspace_id       uuid,
  -- Null means "leave unchanged", so one RPC serves every control in the section without
  -- each write racing the others' reads.
  p_timezone           text    default null,
  p_week_start         integer default null,
  p_default_view       text    default null,
  p_keyboard_shortcuts boolean default null
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

  update public.workspaces
     set timezone           = coalesce(p_timezone, timezone),
         week_start         = coalesce(p_week_start::smallint, week_start),
         default_view       = coalesce(p_default_view, default_view),
         keyboard_shortcuts = coalesce(p_keyboard_shortcuts, keyboard_shortcuts)
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
      'keyboard_shortcuts', p_keyboard_shortcuts
    ))
  );
end;
$$;

-- The old three-parameter signature is a DIFFERENT function to Postgres and would linger
-- callable beside the new one. Drop it explicitly; posture rules apply to what remains.
drop function if exists public.set_workspace_prefs(uuid, text, integer);

-- BOTH revokes, per 0017's closing note: Supabase's default privileges grant EXECUTE to
-- `anon` outright, and Postgres separately grants it to PUBLIC at creation. The sweep in
-- security-posture.test.ts fails the build if either is forgotten.
revoke all     on function public.set_workspace_prefs(uuid, text, integer, text, boolean) from public, anon;
grant  execute on function public.set_workspace_prefs(uuid, text, integer, text, boolean) to authenticated;
