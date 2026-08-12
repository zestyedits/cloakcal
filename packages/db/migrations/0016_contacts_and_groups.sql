-- Contacts and groups — the people `visibility_rules.audience_ref` has always pointed at.
--
-- `visibility_rules` has existed since 0001 with an `audience_ref uuid` column commented
-- "contact or group id", and no foreign key, because no such table existed. Nothing in any
-- TypeScript file has ever read or written that table either; `apps/web/src/server/audience.ts`
-- carries two literal rules and four fictional people. This is the schema that lets View As
-- stop demonstrating the engine and start controlling something.
--
-- ---------------------------------------------------------------------------
-- A CONTACT HAS NO NAME COLUMN, AND THAT IS THE POINT (ADR 0004)
-- ---------------------------------------------------------------------------
--
-- Names, emails, phone numbers and private notes are Cloaked content, filed in
-- `cloaked_fields` under the new `contact` subject type. What lives here in the clear is an
-- id, a workspace, and timestamps — enough for the policy engine to match a rule to a
-- viewer, and nothing more.
--
-- The forcing argument is `attendees`. Spec §"Cloaked fields" lists it as encrypted, and it
-- is. If the same people were then stored in the clear one table over, anyone who could read
-- the contacts table could reconstruct most attendee lists by inference — so encrypting
-- attendees would buy nothing. Two tables cannot disagree about how sensitive the same name
-- is.
--
-- The obvious objection is search, and it does not survive contact with the numbers. A
-- personal address book is tens to low hundreds of rows; the client already holds the root
-- key, already decrypts through `packages/cloak-store`, and can hold the decrypted list in
-- memory. Filtering an array of 200 strings is faster than a network round trip. Encryption
-- costs nothing a user can perceive here.
--
-- The REAL cost, stated plainly: the server cannot answer "is this email address a contact
-- of yours?". That matters for booking pages, where a stranger submits an address and the
-- system wants to recognise them. Booking is deferred by design and does not exist yet; when
-- it does, it needs an explicit mechanism (a blind index, or an envelope) and a decision
-- about what that mechanism leaks. It must not be solved by quietly adding a plaintext email
-- column here.

-- The `contact` and `contact_group` subject types were added in 0015, alone, because a new
-- enum value cannot be used in the transaction that adds it — and a CHECK constraint naming
-- the literal counts as using it. See that file.
--
-- `cloaked_fields` needs no new storage: it already holds one encrypted field per row against
-- (subject_type, subject_id), and its RLS policy is workspace-scoped rather than
-- subject-aware, so it covers contacts unchanged.

-- ---------------------------------------------------------------------------
-- contacts
-- ---------------------------------------------------------------------------

create table public.contacts (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,

  -- No name. No email. No phone. No notes. See the header.

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- Redundant on its own, since `id` is already unique. It exists so the membership table
  -- below can carry a composite foreign key and make a cross-workspace group membership
  -- unrepresentable rather than merely unlikely.
  unique (id, workspace_id)
);

create index contacts_workspace_idx on public.contacts (workspace_id);

-- ---------------------------------------------------------------------------
-- contact_groups
--
-- Named `contact_groups` rather than `groups`: GROUPS is a reserved word in SQL:2011 and
-- Postgres treats it as unreserved-but-special in window frames. A table called `groups`
-- works until someone writes a query where it does not.
-- ---------------------------------------------------------------------------

create table public.contact_groups (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,

  -- No label column, for the same reason contacts have no name. "Clients", "Family",
  -- "Therapy" — a group label describes a relationship, and the list of them is a sketch of
  -- someone's life. Filed in cloaked_fields under the `contact_group` subject type.

  -- D8 tiebreak, denormalised from the rule so two groups cannot disagree about their own
  -- precedence. Lower wins. Rules still carry their own copy for event-scoped overrides.
  priority     integer not null default 100,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  unique (id, workspace_id)
);

create index contact_groups_workspace_idx on public.contact_groups (workspace_id);

-- ---------------------------------------------------------------------------
-- contact_group_members
-- ---------------------------------------------------------------------------

create table public.contact_group_members (
  group_id     uuid not null,
  contact_id   uuid not null,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  created_at   timestamptz not null default now(),

  primary key (group_id, contact_id),

  -- COMPOSITE foreign keys, not plain ones. Both halves carry `workspace_id`, so a group in
  -- one workspace cannot contain a contact from another — the database refuses to represent
  -- it. RLS would not catch this on its own: a user who owns two workspaces passes
  -- `is_workspace_member` for both, so the policy is satisfied while the data is wrong, and
  -- the visibility engine would then resolve an audience across a boundary that is supposed
  -- to be absolute (spec §identity boundaries).
  foreign key (group_id, workspace_id)
    references public.contact_groups (id, workspace_id) on delete cascade,
  foreign key (contact_id, workspace_id)
    references public.contacts (id, workspace_id) on delete cascade
);

create index contact_group_members_contact_idx
  on public.contact_group_members (contact_id);

-- ---------------------------------------------------------------------------
-- RLS — coarse row authorisation only, per rule 3
--
-- These policies decide whether a row is YOURS. They do not, and must not, reason about
-- which audience may see which field; that lives in packages/policy and nowhere else.
-- ---------------------------------------------------------------------------

alter table public.contacts              enable row level security;
alter table public.contact_groups        enable row level security;
alter table public.contact_group_members enable row level security;

alter table public.contacts              force row level security;
alter table public.contact_groups        force row level security;
alter table public.contact_group_members force row level security;

create policy contacts_all on public.contacts
  for all to authenticated
  using (private.is_workspace_member(workspace_id))
  with check (private.is_workspace_member(workspace_id));

create policy contact_groups_all on public.contact_groups
  for all to authenticated
  using (private.is_workspace_member(workspace_id))
  with check (private.is_workspace_member(workspace_id));

create policy contact_group_members_all on public.contact_group_members
  for all to authenticated
  using (private.is_workspace_member(workspace_id))
  with check (private.is_workspace_member(workspace_id));

create trigger contacts_touch
  before update on public.contacts
  for each row execute function public.touch_updated_at();

create trigger contact_groups_touch
  before update on public.contact_groups
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Widen the field-name allowlist to cover the new subjects.
--
-- 0004 added `cloaked_fields_valid_subject_field`, an allowlist of which field names are
-- legal for which subject type. It is an allowlist rather than a denylist, so it also
-- refused every contact field until this ran — the second of two guards that both caught
-- this migration's gap before any test did.
--
-- The contact fields are exactly the CRM-lite set the spec names: "contacts with
-- names/emails/phones, tags/groups, private notes". `custom:%` mirrors the escape hatch
-- events already have, so a user-defined field does not need a migration.
alter table public.cloaked_fields
  drop constraint cloaked_fields_valid_subject_field;

alter table public.cloaked_fields
  add constraint cloaked_fields_valid_subject_field check (
    (subject_type = 'event' and (
      field_name in ('title', 'location', 'notes', 'attendees', 'video_link', 'attachments')
      or field_name like 'custom:%'))
    or (subject_type = 'calendar'  and field_name = 'display_name')
    or (subject_type = 'workspace' and field_name = 'display_name')
    or (subject_type = 'contact' and (
      field_name in ('name', 'email', 'phone', 'notes')
      or field_name like 'custom:%'))
    or (subject_type = 'contact_group' and field_name = 'label')
  );

-- ---------------------------------------------------------------------------
-- Teach the cloaked_fields subject check about the two new subject types.
--
-- 0004's `assert_cloaked_subject_matches` had explicit branches for 'event' and 'calendar'
-- and an `else` that assumed anything else was a workspace subject. That is fail-CLOSED,
-- which is the right default and it worked exactly as intended: adding 'contact' to the enum
-- made every contact field insert fail with "subject does not belong to workspace" until
-- this function was updated. The guard caught its own gap.
--
-- The `else` is now an explicit error rather than a workspace assumption. A silent catch-all
-- is only safe while every unlisted type happens to be workspace-scoped, and that is a
-- property nobody is checking. Naming all five means the NEXT subject type fails with
-- "unknown cloaked subject type" — which says what to do — instead of a workspace mismatch,
-- which sends you looking at the wrong table.
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
  elsif new.subject_type = 'contact' then
    select exists (
      select 1 from public.contacts ct
      where ct.id = new.subject_id and ct.workspace_id = new.workspace_id
    ) into ok;
  elsif new.subject_type = 'contact_group' then
    select exists (
      select 1 from public.contact_groups g
      where g.id = new.subject_id and g.workspace_id = new.workspace_id
    ) into ok;
  elsif new.subject_type = 'workspace' then
    select exists (
      select 1 from public.workspaces w
      where w.id = new.subject_id and w.id = new.workspace_id
    ) into ok;
  else
    raise exception 'unknown cloaked subject type %', new.subject_type
      using errcode = 'check_violation', hint = 'unknown_cloak_subject';
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

grant execute on function private.assert_cloaked_subject_matches() to authenticated;

-- ---------------------------------------------------------------------------
-- audience_ref still has no foreign key, and still cannot have one.
--
-- It points at a contact OR a group depending on the sibling `audience` column, and Postgres
-- has no polymorphic references. The composite keys above are what keep the two sides in one
-- workspace; a rule pointing at a deleted contact is handled by the engine treating an
-- unresolvable audience as no match, which is the safe direction — it withholds rather than
-- discloses. Stated here so the missing constraint reads as a decision rather than an
-- oversight.
-- ---------------------------------------------------------------------------
