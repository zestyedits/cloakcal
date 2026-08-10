# ADR 0003 — M1 is strictly single-owner

**Status:** Accepted (M0 review round 2). **Binding constraint on M1.**
**Condition of:** deferring the redacted-API boundary past M0.

## The bargain

The M0 review accepted deferring the redacted API/view boundary — the rule that
client-facing reads must return redacted output rather than base `events` rows — **on the
condition that M1 stays strictly single-owner**. This ADR records that condition so it
cannot be lost between milestones.

## The constraint

Until the redacted API boundary and its direct-read privacy tests exist, M1 must not
introduce:

- collaborators or shared workspaces of any kind
- team or organisation membership
- any workspace read path where the caller is not the workspace owner
- any client-facing general read over base `events`, `cloaked_fields`, or
  `recurrence_exceptions`

## Why it is load-bearing

Current RLS authorises workspace-scoped tables through `is_workspace_member()`. Under a
single owner, "member" and "owner" are the same person, so coarse row access is exactly
right.

The moment a second person joins a workspace, that equivalence breaks. `USING
(is_workspace_member(...))` would let any member select any member's event rows directly
through PostgREST — obtaining Cloaked ciphertext and, more importantly, the **timing
metadata of events they were never meant to see**. The policy engine cannot prevent this,
because the client would be bypassing it entirely by querying the table.

Redaction is an application-layer concern (plan D2); RLS is the row-level boundary. That
division only holds while nothing hands clients raw rows.

## What must exist before this constraint lifts

1. A redacted read boundary — view, RPC, or server-side API — that returns policy-evaluated
   output. Base tables are not readable by client-facing roles.
2. Tightened RLS so a non-owner member cannot select base rows directly.
3. The privacy test specified in review round 1, item 5.5:

   > A workspace member must be unable to obtain either Cloaked ciphertext or hidden-event
   > metadata through direct table or API access.

4. Policy engine (M2) shipped, since redaction depends on it.

## Enforcement

`workspaces.owner_id` is the only membership signal that exists; there is no membership
table, and adding one is the tripwire. Any pull request introducing collaborator or team
concepts must land items 1–4 first.

Reviewers: treat "just add a members table" as a change to this ADR, not a feature.
