-- Widen route_token from 64 bits to 128 bits (M0 review round 2).
--
-- route_token is opaque metadata, not an authorization boundary — RLS is what actually
-- guards a workspace. But 16 hex characters is only 64 bits, which is inside the range
-- where enumeration is conceivable, and it appears in URLs and therefore in logs, browser
-- history and Referer headers. Correcting it now costs one migration; correcting it after
-- tokens are in circulation costs a redirect strategy.
--
-- A UUID's hex form is exactly 32 characters of 128-bit randomness, so gen_random_uuid()
-- remains the source and no pgcrypto dependency is introduced.

alter table public.workspaces
  alter column route_token set default replace(gen_random_uuid()::text, '-', '');

-- Any token issued before this migration is short and must not survive. There are no rows
-- in any deployed environment, so this is a no-op in practice and a safety net in
-- principle: it guarantees no 64-bit token is left behind.
update public.workspaces
   set route_token = replace(gen_random_uuid()::text, '-', '')
 where route_token !~ '^[0-9a-f]{32}$';

alter table public.workspaces
  add constraint workspaces_route_token_shape
    check (route_token ~ '^[0-9a-f]{32}$');

comment on column public.workspaces.route_token is
  'Opaque 128-bit routing id, 32 hex chars. Never human-readable: display names are Tier B. '
  'Not an authorization boundary — RLS is. Opaque so a workspace name never reaches a URL.';
