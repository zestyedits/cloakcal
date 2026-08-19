-- Take DELETE on `workspaces` away from `authenticated`, before billing makes it expensive.
--
-- WHAT WAS WRONG. `workspaces_delete` (0002) granted every signed-in user DELETE on their own
-- workspace row, and 0024 hung `subscriptions.workspace_id` off it with `on delete cascade`.
-- So one request — `DELETE /rest/v1/workspaces?id=eq.<mine>` — destroys the local record of a
-- paid subscription. A referential action runs internally: it checks neither RLS nor the
-- privileges on the referencing table, which is precisely why 0024's own revoke on
-- `subscriptions` does not stop it.
--
-- WHY NOW, WHEN IT HAS ALWAYS BEEN THERE. Because today it is still true that this only costs
-- the user their own data, and that stops being true the moment Stripe is wired. Then it is:
-- local row gone, provider still charging, nothing left to reconcile against, and no webhook
-- able to fix it — `billing_writer` cannot see `workspaces` at all (0028). ADR 0007 records
-- "deleting an account must cancel its provider subscription first" as an operational
-- requirement no database constraint can enforce. This migration removes the route that would
-- have violated it, rather than adding a constraint that cannot.
--
-- `subscription.test.ts` demonstrated this delete working and called it "harmless today… It
-- stops being harmless once Stripe is wired". That test now proves the opposite, which is the
-- most useful thing in this change.
--
-- AN ALLOWLIST, NOT `revoke delete`. Same argument 0024 and 0025 make, and 0025 paid for it:
-- subtracting the verbs you happened to think of cannot survive a verb you have not heard of,
-- and MAINTAIN is exactly that verb — it did not exist before PostgreSQL 17 and it arrived
-- pre-granted. State what a caller MAY do.
--
-- BOTH LOCKS, DELIBERATELY. The grant is the enforcement: RLS only filters rows a caller
-- already has the privilege to touch, so revoking DELETE is what actually closes this. The
-- policy is dropped as well because a policy naming a capability nobody holds is how the next
-- person concludes deletion is supported and builds on it. Two artifacts, one answer.
--
-- NOTHING IN THE PRODUCT BREAKS. No application code deletes a workspace; the only `.delete()`
-- in apps/web/src removes a passkey wrap. This closes a route nothing used.
--
-- WHAT THIS IS NOT. It is not account deletion, and it does not pretend to be. Deletion stays
-- what the legal copy says it is — by email, by hand — because `auth.users` is unreachable
-- without a service-role key (rule 4) or a SECURITY DEFINER function (banned by
-- security-posture.test.ts). Removing the crude route makes content erasure a GAP rather than
-- a duplicate, and that gap is a deliberate, written trade: a half-delete reachable by a
-- crafted request is worse than no button.

revoke all on public.workspaces from authenticated;
grant select, insert, update on public.workspaces to authenticated;

drop policy if exists workspaces_delete on public.workspaces;

-- ---------------------------------------------------------------------------
-- `profiles`: privilege, not policy omission.
--
-- DELETE is granted here by Supabase's default ACL and there is NO delete policy (0002), so a
-- delete silently affects zero rows. That is denial by omission — the exact failure 0024's
-- header warns about — and it is armed the day anyone adds a permissive policy, because the
-- privilege was sitting there the whole time waiting for one.
--
-- `profiles.id` cascades from `auth.users`, so the row still goes when an operator deletes the
-- account by hand. Nothing needs a user to be able to delete it.
--
-- security-posture.test.ts now sweeps for this shape across every table, because finding it
-- twice by reading is not a strategy.

revoke all on public.profiles from authenticated;
grant select, insert, update on public.profiles to authenticated;
