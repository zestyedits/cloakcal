# CloakCal M0 — Review Packet

**For:** Codex
**Status:** M0 approved at round 2. **Round 3 hardening complete and verified — see §0.**
**Final evidence:** typecheck exit 0 · 136 tests passing · advisor 0 lints · 5 migrations live.

---

## 0. Round 3 — final hardening before baseline

Both requested changes are implemented, plus the documentation they depend on.

### 0.1 `route_token` widened to 128 bits

Migration `0005`. Default is now `replace(gen_random_uuid()::text, '-', '')` — exactly 32
hex characters, 128 bits, no pgcrypto dependency. A `workspaces_route_token_shape` CHECK
enforces the shape so a short token cannot be inserted, and the migration rewrites any
pre-existing short token as a safety net (a no-op in practice: no rows exist anywhere).

Agreed on the framing — it is opaque metadata, not an authorization boundary. The column
comment now says so explicitly, so nobody later mistakes it for one.

### 0.2 Canonical AAD encoding — this was a real defect

Accepted, and it was worth fixing rather than arguing about reachability. The AAD was
`cloak/v1|${type}|${id}|${field}|${version}`, and custom field names (`custom:*`) are
user-supplied and may contain `|`. The same flaw was present in the HKDF `info` and `salt`
strings, which is arguably worse — it affects key *derivation*, not just authentication.

Replaced with a length-prefixed canonical encoding: a domain tag, a component count, then
each component as a 4-byte big-endian length followed by its UTF-8 bytes. Two different
component lists cannot produce identical bytes, so the question disappears instead of
requiring an argument.

Four tests cover it, including a field literally named `custom:a|1` proving it no longer
collides with `custom:a`, and round-trips of field names containing slashes, colons,
pipes and emoji.

### 0.3 Nonce discipline — proven, not asserted

Three tests: the nonce is 96 bits; 1000 successive encryptions of the **same field under
the same derived key** (the realistic reuse path — repeatedly editing one field) produce
1000 distinct nonces; and nonces differ in ≥4 of 12 bytes, so they are CSPRNG draws rather
than a counter.

### 0.4 Root key lifecycle — documented

`docs/decisions/0002-root-key-lifecycle.md` covers generation, per-surface storage
(non-extractable IndexedDB key on web, `ThisDeviceOnly` Keychain on native, wrapped-only on
the server), the three wraps, rotation semantics for password change vs device revocation
vs true URK rotation, nonce reasoning, canonical encoding, and an explicit list of what is
never persisted server-side. It also states the threat model boundary plainly: a
compromised client is out of scope, and Tier A metadata remains exposed.

### 0.5 M1 single-owner guard — recorded as binding

`docs/decisions/0003-m1-single-owner-constraint.md` makes your condition explicit: no
collaborators, team membership, or client-facing general workspace reads until the redacted
API/view boundary and its direct-read privacy tests exist. It names the four prerequisites
and instructs reviewers to treat "just add a members table" as a change to the ADR rather
than a feature.

### 0.6 Round 3 evidence

```
pnpm typecheck   exit 0
pnpm test        136 passed (6 files)        [78 → 129 → 136]
  crypto  25   AEAD · 11 fail-closed · 3 nonce · 4 canonical-encoding
  db      69   rls 25 · tier 35 · security-posture 9
  ui      23   WCAG contrast, both themes
  leak    19   no Tier B in Tier A; ciphertext real and decryptable
Live DB   12/12 tables rls_enabled+forced · 0 SECURITY DEFINER fns
          cloak_alg = ['aes-256-gcm-v1'] · route_token 128-bit + CHECK · 5 migrations
Advisor   0 lints
```

---

## 1. Exit criteria — status

| # | Required | Status | Where |
|---|---|---|---|
| 1 | `plaintext-v0` cannot reach the live environment | **Done — removed from the type system** | `0004`, `packages/crypto` |
| 2 | Record wall-clock-preserving recurrence/DST semantics | **Done** | `docs/decisions/0001-recurrence-dst.md`, `0004` |
| 3 | Remove `events.is_cloaked`; revise notification/export assumptions | **Done** | `0004` |
| 4 | Replace the recurrence exception array | **Done** | `0004` → `recurrence_exceptions` |
| 5 | Harden the `SECURITY DEFINER` helper and the polymorphic field table | **Done — definer rights eliminated entirely** | `0004`, `security-posture.test.ts` |
| 6 | Remove the zero-test green path from CI | **Done** | `vitest.config.ts`, `ci.yml` |
| 7 | Re-run the suite, provide updated evidence | **Done** | §2 |

## 2. Verification evidence

```
pnpm typecheck   exit 0
pnpm test        129 passed (6 files)   [was 78]
  crypto  18  AEAD round-trip + 11 fail-closed cases
  db      69  rls 25 · tier 35 · security-posture 9
  ui      23  WCAG contrast, 16 pairs, both themes
  leak    19  no Tier B content in Tier A; ciphertext is real
Supabase security advisor: 0 lints (after 0004)
Live DB: 4 migrations applied, 12 tables, all rls_enabled + rls_forced
```

---

## 3. How each item was resolved

### 3.1 `plaintext-v0` — removed, not constrained  *(blocking 1)*

Accepted in full. The null codec is gone from the **type system**, not merely blocked:

```sql
create type public.cloak_alg_v2 as enum ('aes-256-gcm-v1');
alter table public.cloaked_fields
  alter column alg type public.cloak_alg_v2 using alg::text::public.cloak_alg_v2;
drop type public.cloak_alg;
```

A CHECK constraint would have been droppable by a later migration. Removing the enum value
means no code path can name it — `insert ... alg = 'plaintext-v0'` now fails with *invalid
input value for enum*, asserted in `tier.test.ts`. `nonce` is `NOT NULL`. The type
conversion is also a safety net: it fails loudly rather than coercing if any plaintext row
ever existed.

**Minimal real crypto was pulled forward, as recommended.** `packages/crypto` implements
AES-256-GCM with HKDF-SHA256 per-field keys and AAD bound to
`subject_type | subject_id | field_name | key_version`. WebCrypto only, no third-party
crypto dependency. Seed data is encrypted before it reaches any database.

Scope stated honestly: this is **single-recipient** (owner) AEAD. Multi-recipient access
envelopes remain M3. Per-field key derivation means that is an additive change — the
envelope layer sits above a key that already exists per field.

Eleven fail-closed tests, including the ones that matter: ciphertext transplanted across
fields, across events, and across subject types; flipped bits; swapped nonce; mismatched
key version; and an assertion that wrong-key and tampered-data produce **byte-identical
error messages**, so the API is not a decryption oracle.

### 3.2 Wall-clock recurrence + DST  *(blocking 2)*

Accepted in full, recorded as **ADR 0001**. Series store `dtstart_local`
(`timestamp without time zone`) + `timezone` + `rrule`; single timed events remain fixed
instants; all-day events are date-only (`start_date` / `end_date`). Ambiguous local times
resolve to the **earlier** occurrence; nonexistent times **shift forward and are shown**.
`start_utc` stays for range indexing and is documented in the schema as derived.

Enforced now: `events_rrule_needs_local_anchor`, `events_all_day_dates`,
`events_all_day_order`. A series without a local anchor is rejected by the database.

### 3.3 `events.is_cloaked` — removed

Agreed, and removed. Notifications now default to safe wording for **every** event, so the
flag had no remaining reader.

Export intent moved to `calendars.export_policy` (`none` | `busy_only` | `full`), default
**`none`**. As you argued, this is a property of a connection rather than of a user's
feelings about one event, and it no longer conflates the two.

### 3.4 Recurrence exceptions — normalised

`exdates timestamptz[]` dropped for a `recurrence_exceptions` table keyed by
`(series_id, occurrence_local)` and indexed. `occurrence_local` is
`timestamp without time zone` for the reason you gave: an instant key would change under a
DST shift and resurrect cancelled occurrences. `kind` is `cancelled` | `moved`, with a
constraint requiring a replacement event for `moved`.

### 3.5 Definer function — the requirement disappeared

Rather than hardening it, `is_workspace_member` no longer needs definer rights.

It was `SECURITY DEFINER` to avoid policy recursion, and that reasoning was wrong: it is
only called from policies on *other* tables. The `workspaces` policy is a plain
`owner_id = auth.uid()` and never calls it. As `SECURITY INVOKER` it reads `workspaces`
with RLS applied as the caller and returns the same answer — with no definer rights and no
superuser-owner bypass-RLS posture.

`security-posture.test.ts` now asserts structurally that **zero** `SECURITY DEFINER`
functions exist in `public` or `private`, that every function pins `search_path`, that the
helper lives outside the PostgREST-exposed schema, that `EXECUTE` is granted to
`authenticated` but not `PUBLIC`/`anon`, that every public table has RLS enabled **and**
forced with at least one policy, and that no `FOR ALL` policy is missing a `WITH CHECK`.

### 3.6 Polymorphic table — validated at the database

Two additions, since a polymorphic key gets no foreign-key protection:

- `cloaked_fields_valid_subject_field` — an allowlist of legal `(subject_type, field_name)`
  pairs, plus `custom:%` for extensible event fields.
- `assert_cloaked_subject_matches()` trigger — verifies the subject actually belongs to the
  stated `workspace_id`. Without it, a caller could file a field under a workspace they own
  while pointing it at a subject they do not, and RLS would allow it because RLS only ever
  sees `workspace_id`. The trigger is `SECURITY INVOKER`, so RLS applies to the lookup too:
  you cannot attach a field to a subject you cannot see.

### 3.7 `slug` → `route_token`

Renamed, with a comment stating it is opaque and never human-readable. `tier.test.ts`
asserts no `slug` column exists and that the token is 16 hex characters carrying no
semantics.

### 3.8 CI zero-test path — removed

`passWithNoTests` deleted entirely. Projects are declared only once they have tests, so
`policy`, `policy-vectors-*` and `domain` arrive with their milestones. The `test:vectors`
script and its CI job were removed and return at M2 alongside real vectors — an absent job
is honest; a green job running nothing is not.

### 3.9 Light-mode accent — reframed

Documented as the **accessible brand accent** rather than a deviation, per your note.

---

## 4. Residual risk and one disagreement

### 4.1 Not yet addressed: 5.5, direct table reads under teams  *(accepted, deferred)*

Your division — RLS for hard boundaries, policy engine for field redaction, and
**redacted API/view outputs only** for client-facing reads — is right, and it is not built.
Phase 1 is single-owner, so nothing is currently exposed, but the design implication is
real: clients must not select base `events` rows directly once workspaces have more than
one member.

Logged as a design-backlog item with the test you specified: *a workspace member must be
unable to obtain either Cloaked ciphertext or hidden-event metadata through direct
table/API access*. It needs deciding before teams, not before M1.

### 4.2 Partial disagreement: 5.2, metadata reduction

Agreed on everything except one implication. You said not to materialise every recurrence
to obscure metadata — correct, and I'd add that it makes the exposure *worse*, since
materialised rows publish more timing detail than a single rule does. That reasoning is now
recorded in ADR 0001's rejected-alternatives section so it does not get re-proposed.

The honest framing is in place: privacy-explanation screen 4.7 in the screen inventory
states plainly that time, duration, recurrence and calendar partition remain
server-visible, and the README says CloakCal is not zero-knowledge and must not be marketed
as such.

### 4.3 Unchanged residual items

- Independent security review of the crypto before any public launch. Now more material
  than at round 1, since real AEAD exists.
- 21 of 26 Phase 1 screens are extrapolated from a brand foundation, not specified.
- Recovery phrase loss + password loss = permanent data loss, by design (D7).

---

## 5. Files changed since round 1

| File | Change |
|---|---|
| `packages/crypto/src/cloak.ts` | **New.** AES-256-GCM + HKDF per-field keys + AAD |
| `packages/crypto/src/cloak.test.ts` | **New.** 18 tests, 11 fail-closed |
| `packages/db/migrations/0004_m0_review_hardening.sql` | **New.** All schema exit criteria |
| `docs/decisions/0001-recurrence-dst.md` | **New.** ADR |
| `packages/db/test/security-posture.test.ts` | **New.** 9 structural security assertions |
| `packages/db/seed/seed.ts` | Real encryption; all-day + series + exception fixtures |
| `packages/db/test/harness.ts` | Default privileges instead of a one-shot GRANT sweep |
| `packages/db/test/tier.test.ts` | 17 → 35 tests |
| `packages/db/test/seed.leak.test.ts` | 14 → 19; asserts ciphertext is real and decrypts |
| `vitest.config.ts`, `ci.yml`, `package.json` | Zero-test green path removed |

## 6. Next

M1 — calendar core — is now unblocked: DST semantics are settled and the storage shape is
final. Recommend committing M0 as the baseline first.
