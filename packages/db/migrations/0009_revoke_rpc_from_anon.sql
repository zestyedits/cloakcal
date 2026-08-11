-- Close a grant that 0007 and 0008 both believed they had already closed.
--
-- THE BUG. Both migrations end with `revoke all on function ... from public`, which reads
-- like it locks the function to authenticated callers. It does not. `PUBLIC` is the implicit
-- pseudo-role; Supabase separately runs
--
--   alter default privileges in schema public grant all on functions to anon, authenticated, service_role
--
-- so every function gets an EXPLICIT grant to `anon` at creation time. Revoking from PUBLIC
-- leaves that explicit grant untouched, and `has_function_privilege('anon', ..., 'execute')`
-- returns true for both RPCs. Verified against the live project, not inferred.
--
-- WHAT IT WAS AND WAS NOT. Not an exposure: both functions are SECURITY INVOKER, so an anon
-- caller has `auth.uid() = null`, RLS matches no rows, and trash_cloaked_event answers "does
-- not exist" for every id — which is also what it tells a signed-in stranger. Nothing leaked.
-- But an unauthenticated caller could still enter the function body and make it do work, and
-- the next function written to this template might not be so lucky. The revoke should mean
-- what it says.
--
-- WHY THE TESTS MISSED IT. `packages/db/test/harness.ts` has no `anon` role at all — its
-- `asAnon` helper runs as `authenticated` with no JWT subject, which is a different thing
-- from Supabase's unauthenticated role. So "is not callable anonymously" passed while being
-- untrue in production. The harness now creates `anon` and mirrors Supabase's default
-- privileges, so this class of gap is visible where it was previously invisible.

revoke all on function public.create_cloaked_event(
  uuid, uuid, uuid, text, timestamptz, timestamptz, timestamp, boolean, date, date, text,
  public.busy_status, jsonb
) from anon;

revoke all on function public.trash_cloaked_event(uuid, integer) from anon;

-- Future functions in this schema should not have to remember. Supabase's default grant is
-- convenient for a public-read app and wrong for this one: nothing in CloakCal is readable
-- without a session, so no RPC should be reachable without one either.
alter default privileges in schema public revoke execute on functions from anon;
