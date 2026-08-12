-- Workspace preferences: the display timezone, and turning week_start on.
--
-- `week_start` has existed since 0001 and `weekRange()` has honoured it since M1 — but no
-- TypeScript ever read it from the database, so every account started its week on Sunday.
-- The timezone is newer: `DISPLAY_TIMEZONE` in apps/web/src/server/range.ts is a module
-- constant, so every account renders in New York. This migration gives both a write path;
-- the settings screen is what makes them reachable.
--
-- ---------------------------------------------------------------------------
-- ADR 0001: THE TIMEZONE CHANGES DISPLAY FRAMING ONLY
-- ---------------------------------------------------------------------------
--
-- Local wall time is authoritative and stored per event; this preference decides only the
-- zone the *view* is framed in — which week a Tuesday belongs to, where the day boundaries
-- fall on screen. Changing it re-frames queries and re-renders; it re-stores NOTHING, and a
-- migration that touched dtstart_local here would be wrong.
--
-- ---------------------------------------------------------------------------
-- THE CHECK IS A SHAPE CHECK, NOT IANA VALIDATION, DELIBERATELY
-- ---------------------------------------------------------------------------
--
-- Postgres can validate a zone name against its own tz database — and the db tests run on
-- PGlite, whose tz table must not become load-bearing for what the app accepts. Real
-- validation happens where the zones will actually be used: the client offers only
-- Intl.supportedValuesOf('timeZone'), and the server read path degrades an unusable stored
-- zone to the default rather than throwing. The shape check only keeps out things that are
-- obviously not zone names at all.
--
-- ---------------------------------------------------------------------------
-- NO VERSION GUARD, per 0017's reasoning
-- ---------------------------------------------------------------------------
--
-- A preference is one row one person overwrites; last write wins IS the semantics, and a
-- version column would put "someone else changed this, reload" in front of a double-click.

alter table public.workspaces
  add column timezone text not null default 'America/New_York';

alter table public.workspaces
  add constraint workspaces_timezone_shape
  check (
    timezone ~ '^[A-Za-z_][A-Za-z0-9_+\-]*(/[A-Za-z0-9_+\-]+){0,2}$'
    and length(timezone) <= 64
  );

create or replace function public.set_workspace_prefs(
  p_workspace_id uuid,
  -- Null means "leave unchanged", so one RPC serves every control in the section without
  -- each write racing the others' reads.
  p_timezone     text    default null,
  p_week_start   integer default null
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

  update public.workspaces
     set timezone   = coalesce(p_timezone, timezone),
         week_start = coalesce(p_week_start::smallint, week_start)
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
    jsonb_strip_nulls(jsonb_build_object('timezone', p_timezone, 'week_start', p_week_start))
  );
end;
$$;

-- BOTH revokes, per 0017's closing note: Supabase's default privileges grant EXECUTE to
-- `anon` outright, and Postgres separately grants it to PUBLIC at creation. The sweep in
-- security-posture.test.ts fails the build if either is forgotten.
revoke all     on function public.set_workspace_prefs(uuid, text, integer) from public, anon;
grant  execute on function public.set_workspace_prefs(uuid, text, integer) to authenticated;
