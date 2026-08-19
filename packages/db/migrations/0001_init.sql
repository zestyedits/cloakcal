-- CloakCal Phase 1 — initial schema
--
-- TIER DISCIPLINE (see plan §4 Data classification matrix):
--   Everything in THIS file is Tier A: operational metadata the server must process.
--   Tier B content (title, location, notes, attendees, video link, attachments,
--   display names) exists ONLY as opaque bytes in public.cloaked_fields.
--   There is deliberately no plaintext `title` column anywhere. Adding one would be
--   a tier violation and must fail review.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type public.cloak_subject     as enum ('event', 'calendar', 'workspace');
create type public.lifecycle_state   as enum ('active', 'trashed', 'purged');
create type public.busy_status       as enum ('busy', 'free', 'tentative');
create type public.time_visibility   as enum ('exact', 'busy', 'hidden');
create type public.audience_kind     as enum ('owner', 'individual', 'group', 'public');

-- 'plaintext-v0' is a DEVELOPMENT-ONLY null codec used by M1 so calendar CRUD can be
-- built and tested before the crypto boundary lands at M3. It stores UTF-8 bytes with
-- no confidentiality whatsoever.
--
-- M3 MUST add:  alter table public.cloaked_fields
--                 add constraint cloaked_fields_no_plaintext
--                 check (alg <> 'plaintext-v0');
-- CI enforces this independently — see packages/db/test/tier.test.ts
create type public.cloak_alg as enum ('plaintext-v0', 'aes-256-gcm-v1');

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Workspaces (identity boundaries — real boundaries, not folders. Spec §3)
-- ---------------------------------------------------------------------------

create table public.workspaces (
  id                      uuid primary key default gen_random_uuid(),
  owner_id                uuid not null references auth.users (id) on delete cascade,

  -- Tier A by necessity (used in URLs/routing). Defaults to a random token precisely
  -- so a workspace name like "therapy-practice" never becomes server-visible metadata.
  -- The human-readable display name is Tier B, in cloaked_fields.
  -- gen_random_uuid() is core Postgres; gen_random_bytes() would require pgcrypto,
  -- which PGlite does not bundle by default and CI must not depend on.
  slug                    text not null
                            default substr(replace(gen_random_uuid()::text, '-', ''), 1, 16),

  kind                    text not null default 'personal'
                            check (kind in ('personal', 'freelance', 'firm', 'public')),
  default_time_visibility public.time_visibility not null default 'busy',
  week_start              smallint not null default 0 check (week_start between 0 and 6),
  lifecycle               public.lifecycle_state not null default 'active',
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  unique (owner_id, slug)
);

create index workspaces_owner_idx on public.workspaces (owner_id) where lifecycle = 'active';

-- ---------------------------------------------------------------------------
-- Calendars
-- ---------------------------------------------------------------------------

create table public.calendars (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  color_token   text not null default 'indigo',   -- design-token name, not a leak vector
  sort_order    integer not null default 0,
  is_default    boolean not null default false,
  lifecycle     public.lifecycle_state not null default 'active',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index calendars_workspace_idx on public.calendars (workspace_id) where lifecycle = 'active';
create unique index calendars_one_default_per_workspace
  on public.calendars (workspace_id) where is_default and lifecycle = 'active';

-- ---------------------------------------------------------------------------
-- Events — Tier A metadata only
-- ---------------------------------------------------------------------------

create table public.events (
  id                        uuid primary key default gen_random_uuid(),
  workspace_id              uuid not null references public.workspaces (id) on delete cascade,
  calendar_id               uuid not null references public.calendars (id) on delete restrict,
  owner_id                  uuid not null references auth.users (id) on delete cascade,

  start_utc                 timestamptz not null,
  end_utc                   timestamptz not null,
  timezone                  text not null,          -- IANA zone; required for correct recurrence
  all_day                   boolean not null default false,

  rrule                     text,                   -- RFC 5545
  exdates                   timestamptz[] not null default '{}',
  recurrence_parent_id      uuid references public.events (id) on delete cascade,
  recurrence_instance_start timestamptz,            -- set on materialised exception instances

  busy                      public.busy_status not null default 'busy',
  reminder_offsets          integer[] not null default '{}',   -- minutes before start

  -- Server must know an event is Cloaked to choose privacy-safe notification wording (D3).
  -- This is a flag, never content.
  --
  -- ANNOTATED LATER: 0004 DROPS THIS COLUMN. It was "the most revealing single bit in the
  -- schema" — a per-event marker of what the user considers sensitive — and notifications now
  -- default to safe wording for EVERY event instead. The DDL below stays as applied, because
  -- a migration is history; this note is here so nobody designing reminders from 0001 alone
  -- reaches for a bit that was deliberately destroyed.
  is_cloaked                boolean not null default false,

  lifecycle                 public.lifecycle_state not null default 'active',
  trashed_at                timestamptz,
  version                   integer not null default 1,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint events_time_order check (end_utc >= start_utc),
  constraint events_recurrence_pair
    check ((recurrence_parent_id is null) = (recurrence_instance_start is null)),
  constraint events_trashed_pair
    check ((lifecycle = 'trashed') = (trashed_at is not null))
);

create index events_workspace_range_idx on public.events (workspace_id, start_utc, end_utc)
  where lifecycle = 'active';
create index events_calendar_idx on public.events (calendar_id) where lifecycle = 'active';
create index events_recurrence_parent_idx on public.events (recurrence_parent_id)
  where recurrence_parent_id is not null;

-- ---------------------------------------------------------------------------
-- Cloaked fields — Tier B. Opaque to the server, always.
-- ---------------------------------------------------------------------------
--
-- One row per (subject, field). This per-field split is what makes field-level
-- visibility possible at all: you cannot disclose "title but not location" out of a
-- single sealed blob.
--
-- workspace_id is denormalised so RLS can authorise without a polymorphic join
-- across three possible subject tables.

create table public.cloaked_fields (
  id            uuid primary key default gen_random_uuid(),
  subject_type  public.cloak_subject not null,
  subject_id    uuid not null,
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,

  field_name    text not null,
  ciphertext    bytea not null,
  nonce         bytea,
  alg           public.cloak_alg not null,
  key_version   integer not null default 1,
  version       integer not null default 1,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (subject_type, subject_id, field_name),

  -- Real AEAD requires a nonce; the dev null codec must not carry one.
  constraint cloaked_fields_nonce_required
    check ((alg = 'aes-256-gcm-v1') = (nonce is not null))
);

create index cloaked_fields_subject_idx on public.cloaked_fields (subject_type, subject_id);
create index cloaked_fields_workspace_idx on public.cloaked_fields (workspace_id);

-- ---------------------------------------------------------------------------
-- Visibility rules — inputs to the policy engine. The engine itself lives in
-- packages/policy; Postgres stores rules but never decides field visibility.
-- ---------------------------------------------------------------------------

create table public.visibility_rules (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces (id) on delete cascade,
  scope           text not null check (scope in ('workspace', 'event')),
  event_id        uuid references public.events (id) on delete cascade,

  audience        public.audience_kind not null,
  audience_ref    uuid,               -- contact or group id; null for owner/public
  group_priority  integer,            -- D8 tiebreak: lower wins

  time_vis        public.time_visibility not null default 'busy',
  fields          jsonb not null default '{}'::jsonb,   -- { "title": "visible", ... }

  reveal_at       timestamptz,        -- delayed reveal
  expires_at      timestamptz,        -- temporary access / auto-revert

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint visibility_rules_scope_pair check ((scope = 'event') = (event_id is not null)),
  constraint visibility_rules_group_priority
    check ((audience = 'group') = (group_priority is not null)),
  constraint visibility_rules_audience_ref
    check ((audience in ('individual', 'group')) = (audience_ref is not null)),
  constraint visibility_rules_window check (expires_at is null or reveal_at is null
                                            or expires_at > reveal_at)
);

create index visibility_rules_event_idx on public.visibility_rules (event_id)
  where event_id is not null;
create index visibility_rules_workspace_idx on public.visibility_rules (workspace_id);

-- ---------------------------------------------------------------------------
-- Presets — convenience layers over field-level rules (Free tier, per D5)
-- ---------------------------------------------------------------------------

create table public.presets (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  key           text not null,
  is_builtin    boolean not null default false,
  time_vis      public.time_visibility not null,
  fields        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  unique (workspace_id, key)
);

-- ---------------------------------------------------------------------------
-- Devices & access envelopes — populated at M3, defined now so the shape is fixed
-- ---------------------------------------------------------------------------

create table public.devices (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  label             text not null,
  public_key        bytea not null,          -- X25519
  wrapped_root_key  bytea,                   -- URK wrapped to this device (D7)
  last_seen_at      timestamptz,
  revoked_at        timestamptz,
  created_at        timestamptz not null default now()
);

create index devices_user_idx on public.devices (user_id) where revoked_at is null;

create table public.access_envelopes (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references public.events (id) on delete cascade,
  workspace_id    uuid not null references public.workspaces (id) on delete cascade,
  recipient_kind  text not null check (recipient_kind in ('device', 'contact')),
  recipient_ref   uuid not null,
  field_name      text not null,             -- envelopes are per-field (HKDF-derived key)
  wrapped_key     bytea not null,
  key_version     integer not null default 1,
  created_at      timestamptz not null default now(),
  unique (event_id, recipient_kind, recipient_ref, field_name)
);

create index access_envelopes_event_idx on public.access_envelopes (event_id);

-- ---------------------------------------------------------------------------
-- Idempotency ledger — server half of the offline outbox (client half is IndexedDB)
-- ---------------------------------------------------------------------------

create table public.applied_ops (
  idempotency_key uuid primary key,
  user_id         uuid not null references auth.users (id) on delete cascade,
  op_kind         text not null,
  result          jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Audit log — metadata only. Writing Tier B plaintext here is a privacy defect.
-- ---------------------------------------------------------------------------

create table public.audit_log (
  id            bigint generated always as identity primary key,
  workspace_id  uuid references public.workspaces (id) on delete cascade,
  actor_id      uuid references auth.users (id) on delete set null,
  action        text not null,
  subject_type  text,
  subject_id    uuid,
  detail        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index audit_log_workspace_idx on public.audit_log (workspace_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

-- search_path is pinned: an unqualified name inside a SECURITY-sensitive function is a
-- classic hijack vector, and Supabase's security advisor flags a mutable search_path
-- on any function reachable from user SQL.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger workspaces_touch       before update on public.workspaces
  for each row execute function public.touch_updated_at();
create trigger calendars_touch        before update on public.calendars
  for each row execute function public.touch_updated_at();
create trigger events_touch           before update on public.events
  for each row execute function public.touch_updated_at();
create trigger cloaked_fields_touch   before update on public.cloaked_fields
  for each row execute function public.touch_updated_at();
create trigger visibility_rules_touch before update on public.visibility_rules
  for each row execute function public.touch_updated_at();
create trigger profiles_touch         before update on public.profiles
  for each row execute function public.touch_updated_at();
