-- M0 review hardening. Implements the required exit criteria from docs/M0-REVIEW.md.
--
-- 1. plaintext-v0 removed from the type system entirely — not merely constrained.
-- 2. events.is_cloaked dropped; export intent moves to the calendar, where it belongs.
-- 3. Wall-clock-preserving recurrence: a local anchor becomes the authority for series.
-- 4. exdates array replaced by a normalised, indexable exception table.
-- 5. Polymorphic cloaked_fields gains the validation a real foreign key would have given it.
-- 6. workspaces.slug renamed route_token — it is an opaque routing id, never human-readable.

-- ---------------------------------------------------------------------------
-- 1. plaintext-v0 cannot exist
-- ---------------------------------------------------------------------------
--
-- Recreating the enum rather than adding a CHECK is deliberate: a CHECK can be dropped by
-- a later migration, whereas removing the value means no code path can even name it. The
-- type conversion below FAILS LOUDLY if any plaintext row exists, which is the desired
-- behaviour — this migration must never silently discard or coerce unencrypted content.

alter table public.cloaked_fields drop constraint cloaked_fields_nonce_required;

create type public.cloak_alg_v2 as enum ('aes-256-gcm-v1');

alter table public.cloaked_fields
  alter column alg type public.cloak_alg_v2 using alg::text::public.cloak_alg_v2;

drop type public.cloak_alg;
alter type public.cloak_alg_v2 rename to cloak_alg;

-- AES-GCM always has a nonce, and there is now no algorithm that does not.
alter table public.cloaked_fields alter column nonce set not null;

-- ---------------------------------------------------------------------------
-- 2. Drop the sensitivity flag; move export intent to the calendar
-- ---------------------------------------------------------------------------
--
-- events.is_cloaked told the server which events the user considers sensitive — the most
-- revealing single bit in the schema. Notifications now default to safe wording for ALL
-- events (deny by default), so the flag has no remaining reader.
--
-- External sync is a property of a connection, not of a user's feelings about one event.
-- Default 'none': a calendar exports nothing until someone deliberately says otherwise.

alter table public.events drop column is_cloaked;

alter table public.calendars
  add column export_policy text not null default 'none'
    check (export_policy in ('none', 'busy_only', 'full'));

comment on column public.calendars.export_policy is
  'Controls what may leave CloakCal for an external provider. Defaults to none; never inferred.';

-- ---------------------------------------------------------------------------
-- 3. Wall-clock-preserving recurrence
-- ---------------------------------------------------------------------------
--
-- A UTC instant plus an IANA zone is correct for a single fixed appointment, but it is
-- NOT sufficient for a series: "09:00 every Tuesday" must stay 09:00 after a DST shift,
-- which means the local wall time is the authority and each instant is derived from it.
--
-- dtstart_local is `timestamp` (no zone) on purpose. It is a wall-clock reading, not an
-- instant, and giving it a zone would re-introduce exactly the ambiguity it exists to
-- remove. See docs/decisions/0001-recurrence-dst.md for the ambiguity/gap policy.

alter table public.events
  add column dtstart_local timestamp,
  add column start_date date,
  add column end_date date;

comment on column public.events.dtstart_local is
  'Authoritative local wall-clock anchor for a recurring series. Required when rrule is set.';
comment on column public.events.start_utc is
  'Resolved instant. Authoritative for single timed events; DERIVED for series and all-day.';

alter table public.events
  add constraint events_rrule_needs_local_anchor
    check (rrule is null or dtstart_local is not null),
  -- All-day events are date-only. Storing them as midnight timestamps makes them shift
  -- across timezones, which is the classic all-day calendar bug.
  add constraint events_all_day_dates
    check (all_day = (start_date is not null and end_date is not null)),
  add constraint events_all_day_order
    check (start_date is null or end_date is null or end_date >= start_date);

-- ---------------------------------------------------------------------------
-- 4. Normalised recurrence exceptions
-- ---------------------------------------------------------------------------
--
-- The exdates array could not be indexed and would have grown unboundedly on a
-- long-lived series. The exception key is the ORIGINAL LOCAL occurrence, not a UTC
-- instant: if it were an instant, a DST shift would change the key and previously
-- cancelled occurrences would silently reappear.

alter table public.events drop column exdates;

create table public.recurrence_exceptions (
  id                   uuid primary key default gen_random_uuid(),
  series_id            uuid not null references public.events (id) on delete cascade,
  workspace_id         uuid not null references public.workspaces (id) on delete cascade,
  occurrence_local     timestamp not null,
  kind                 text not null check (kind in ('cancelled', 'moved')),
  replacement_event_id uuid references public.events (id) on delete set null,
  created_at           timestamptz not null default now(),

  unique (series_id, occurrence_local),
  constraint recurrence_exceptions_moved_pair
    check ((kind = 'moved') = (replacement_event_id is not null))
);

create index recurrence_exceptions_series_idx
  on public.recurrence_exceptions (series_id, occurrence_local);

alter table public.recurrence_exceptions enable row level security;
alter table public.recurrence_exceptions force row level security;

create policy recurrence_exceptions_all on public.recurrence_exceptions
  for all to authenticated
  using (private.is_workspace_member(workspace_id))
  with check (private.is_workspace_member(workspace_id));

-- ---------------------------------------------------------------------------
-- 5. Validate the polymorphic subject
-- ---------------------------------------------------------------------------
--
-- (subject_type, subject_id) cannot have a foreign key, so it gets none of the integrity
-- Postgres would normally provide. Two things need enforcing: that the field name is
-- legal for the subject type, and that the denormalised workspace_id actually matches the
-- subject's workspace — otherwise a caller could file a field under a workspace they own
-- while pointing it at a subject they do not, and RLS would happily allow it.

alter table public.cloaked_fields
  add constraint cloaked_fields_valid_subject_field check (
    (subject_type = 'event' and (
      field_name in ('title', 'location', 'notes', 'attendees', 'video_link', 'attachments')
      or field_name like 'custom:%'))
    or (subject_type = 'calendar'  and field_name = 'display_name')
    or (subject_type = 'workspace' and field_name = 'display_name')
  );

-- SECURITY INVOKER, not DEFINER. Running as the caller means RLS applies to the lookup,
-- so attaching a field to a subject the caller cannot see fails — defense in depth that a
-- definer-rights version would have thrown away.
create or replace function private.assert_cloaked_subject_matches()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  ok boolean;
begin
  if new.subject_type = 'event' then
    select exists (
      select 1 from public.events e
      where e.id = new.subject_id and e.workspace_id = new.workspace_id
    ) into ok;
  elsif new.subject_type = 'calendar' then
    select exists (
      select 1 from public.calendars c
      where c.id = new.subject_id and c.workspace_id = new.workspace_id
    ) into ok;
  else
    select exists (
      select 1 from public.workspaces w
      where w.id = new.subject_id and w.id = new.workspace_id
    ) into ok;
  end if;

  if not ok then
    raise exception
      'cloaked_fields subject (%, %) does not belong to workspace %',
      new.subject_type, new.subject_id, new.workspace_id
      using errcode = 'foreign_key_violation';
  end if;

  return new;
end;
$$;

create trigger cloaked_fields_subject_check
  before insert or update on public.cloaked_fields
  for each row execute function private.assert_cloaked_subject_matches();

grant execute on function private.assert_cloaked_subject_matches() to authenticated;

-- ---------------------------------------------------------------------------
-- 5b. is_workspace_member no longer needs definer rights at all
-- ---------------------------------------------------------------------------
--
-- It was SECURITY DEFINER to avoid policy recursion. That reasoning was wrong: the helper
-- is only ever called from policies on OTHER tables. The workspaces table's own policy is
-- a plain `owner_id = auth.uid()` and never calls it, so there is no recursion to escape.
--
-- As SECURITY INVOKER it reads workspaces with RLS applied as the caller, which yields
-- exactly the same answer. This removes the entire concern rather than mitigating it:
-- no definer rights, and no execution as a superuser owner that would bypass RLS.

create or replace function private.is_workspace_member(ws uuid)
returns boolean
language sql
stable
security invoker
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

-- ---------------------------------------------------------------------------
-- 6. slug -> route_token
-- ---------------------------------------------------------------------------
--
-- "slug" implies a readable, meaningful string. This value is deliberately opaque and
-- high-entropy so a workspace name never reaches a URL, a log line or a Referer header.

alter table public.workspaces rename column slug to route_token;

comment on column public.workspaces.route_token is
  'Opaque high-entropy routing id. Never human-readable: display names are Tier B.';
