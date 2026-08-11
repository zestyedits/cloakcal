-- Close the function grants 0009 believed it had already closed, and stop believing.
--
-- WHAT 0009 GOT WRONG. It revoked Supabase's default `anon` grant and concluded that new
-- functions were then safe. They are not. There are TWO grants of EXECUTE, and each one
-- hides the other:
--
--   1. Supabase: `alter default privileges in schema public grant all on functions to anon,
--      authenticated, service_role`. 0009 revoked this one, and that part worked.
--   2. Postgres itself: EXECUTE on every new function is granted to PUBLIC, always, and
--      `anon` inherits through PUBLIC.
--
-- AND (2) CANNOT BE TURNED OFF. `alter default privileges ... revoke execute on functions
-- from public` looks like the fix and is a silent no-op: the built-in grant is implicit
-- rather than a stored default, so there is nothing for the revoke to remove. Verified on
-- this actual Supabase project inside a rolled-back transaction, not inferred — a function
-- created after both revokes still comes out with `=X/postgres` in its ACL and still answers
-- `has_function_privilege('anon', ...) = true`.
--
-- So there is no "safe by default" to be had. Every function needs an explicit
-- `revoke all on function ... from public` and `... from anon`, and the thing that makes
-- forgetting survivable is the sweep in security-posture.test.ts, which fails if ANY function
-- in `public` is executable by `anon`. Trust the test, not the reasoning.
--
-- THE ONE THAT SLIPPED THROUGH: `touch_updated_at`, the timestamp trigger from 0001. Harmless
-- on its own — it only assigns `new.updated_at` and errors outside a trigger context — but it
-- is proof the default was doing the wrong thing quietly.
--
-- Revoking EXECUTE from a trigger function does not break the trigger: Postgres checks the
-- privilege when the trigger is CREATED, not each time it fires.

revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;

-- The blanket revoke above took the RPCs with it. Hand them back to signed-in callers only.
grant execute on function public.create_cloaked_event(
  uuid, uuid, uuid, text, timestamptz, timestamptz, timestamp, boolean, date, date, text,
  public.busy_status, jsonb
) to authenticated;

grant execute on function public.trash_cloaked_event(uuid, integer) to authenticated;
