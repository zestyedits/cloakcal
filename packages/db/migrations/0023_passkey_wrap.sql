-- ADR 0005 — a fourth wrap kind, `passkey`, whose wrapping key is derived from the
-- WebAuthn PRF extension output for a registered credential.
--
-- This is a schema-only migration and adds NO functions, deliberately. `root_key_wraps` is
-- the documented exception to one-RPC-per-action: the client reads and writes it directly
-- under RLS, because every value in it is bytes the server cannot open and there is no
-- server-side decision to make about them. An RPC here would add a plpgsql layer whose
-- only job is to pass ciphertext through, and it would be the fifth place a wrap's shape
-- is described. The CHECK constraints below ARE the validation, and unlike a function they
-- cannot be bypassed by a caller who talks to the table instead.
--
-- WHY A MIGRATION AT ALL, rather than an enum change: `kind` is a CHECK constraint, not a
-- Postgres enum (0006 chose that, and it is the cheaper end of the trade — `alter type ...
-- add value` cannot run inside a transaction with other DDL). So widening it is
-- drop-and-recreate. The dropped constraint's name is the one Postgres generated for the
-- inline column check in 0006; failing loudly on a rename is correct, so it is not guarded.
--
-- WHAT DOES NOT CHANGE, and why that is a finding rather than an omission:
--
--   * `root_key_wraps_kdf_pair` stays `(kind = 'password') = (kdf is not null)`. A passkey
--     wrap has NO kdf: there is no Argon2id derivation, the authenticator produces the PRF
--     output and HKDF turns it into a wrapping key with parameters fixed in client code.
--     The prf_salt therefore needs its own column — it could not live in `kdf` even if we
--     wanted it to, because this constraint forbids `kdf` on every non-password kind.
--
--   * ADR 0006's random 16-byte Argon2id salt needs NOTHING here. It lives inside the
--     existing `kdf` jsonb as a `salt` key, and `kdf` is untyped jsonb with no shape
--     constraint anywhere in the schema — verified against the constraint list on this
--     table, not assumed. Adding a `kdf_salt` column would be a second home for a fact the
--     blob already carries, and would then need its own pairing CHECK to stay consistent
--     with `saltEmail` sitting one key over. The read rule (`kdf.salt` present → use those
--     bytes, else `saltEmail`) is entirely client-side and the server has no opinion.
--
--   * The RLS policy is untouched, and a new kind inherits row authorisation from it
--     automatically. `root_key_wraps_all` is `for all to authenticated` on
--     `user_id = auth.uid()`, USING and WITH CHECK both — policies are row-level, not
--     column- or value-level, so a `passkey` row is authorised by the same predicate as a
--     `password` one with no edit. Confirmed by reading 0006 and pinned by the
--     cross-user test in root-key-wraps.test.ts, which now covers a passkey row too.
--     The only column the policy references is `user_id`, already indexed by
--     `root_key_wraps_user_idx`.

alter table public.root_key_wraps
  drop constraint root_key_wraps_kind_check,
  add constraint root_key_wraps_kind_known
    check (kind in ('password', 'recovery', 'device', 'passkey'));

alter table public.root_key_wraps
  -- The WebAuthn credential id, raw. Not a secret — it is handed to any origin that asks
  -- for an assertion — but it is the only thing that distinguishes one passkey wrap from
  -- another, which is why the unique index below is on it.
  add column credential_id bytea,

  -- The PRF evaluation input. Random, generated client-side, 32 bytes, and stored in the
  -- clear because it IS in the clear: it is an HKDF input, and the secret is the
  -- authenticator's PRF key, which never leaves the authenticator (ADR 0005). Per
  -- credential rather than per user so two credentials on one account never derive the
  -- same wrapping key.
  add column prf_salt bytea,

  -- Paired biconditionals, matching 0006's device_pair / ephemeral_pair / kdf_pair. Both
  -- directions are load-bearing: `not null on a passkey` stops a wrap nothing can ever
  -- open again, and `null on every other kind` stops a password wrap carrying a stale
  -- credential id that a later reader might try to assert against.
  add constraint root_key_wraps_credential_pair
    check ((kind = 'passkey') = (credential_id is not null)),
  add constraint root_key_wraps_prf_salt_pair
    check ((kind = 'passkey') = (prf_salt is not null)),

  -- WebAuthn requires a credential id of at least 16 bytes (§5.8.3), and CTAP2
  -- authenticators cap it at 1023. A value outside that is not a credential id, whatever
  -- it claims — same reasoning as root_key_wraps_length on the wrap itself.
  add constraint root_key_wraps_credential_id_length
    check (credential_id is null or octet_length(credential_id) between 16 and 1023),

  -- Exactly 32, not "at least". A short salt would still derive A key, and the wrap would
  -- still open, so nothing downstream would ever notice it was weak.
  add constraint root_key_wraps_prf_salt_length
    check (prf_salt is null or octet_length(prf_salt) = 32);

comment on column public.root_key_wraps.credential_id is
  'Raw WebAuthn credential id for kind=''passkey''. Public by construction; identifies '
  'which authenticator this wrap opens under. See docs/decisions/0005-passkey-wrap.md.';
comment on column public.root_key_wraps.prf_salt is
  'PRF evaluation input (32 random bytes) for kind=''passkey''. An HKDF salt, not a '
  'secret — the secret never leaves the authenticator.';

-- THE FIRST WRAP KIND THAT IS NOT ONE-PER-USER, and that is the decision, not an
-- oversight. A laptop and a phone are two credentials; a user with one passkey and no
-- phrase is one lost device from nothing (ADR 0005). So this index is on
-- (user_id, credential_id), NOT on (user_id).
--
-- 0006's warning about the silent fork still applies and is satisfied differently here.
-- Two password wraps is a fork because changing the password rewrites one and leaves the
-- other opening the account with a retired secret. Two passkey wraps is not: each one is
-- pinned to a distinct authenticator that must be present and user-verified to produce
-- anything, and revoking one is deleting its row. What WOULD be a fork is two rows for the
-- same credential — the older one would keep opening under a PRF salt the user thought
-- they had replaced — and that is exactly what this index makes unrepresentable.
create unique index root_key_wraps_one_per_credential
  on public.root_key_wraps (user_id, credential_id) where kind = 'passkey';

-- NO unique index on prf_salt, and this is deliberate rather than forgotten. Uniqueness
-- per credential is what ADR 0005 asks for and the index above already delivers it, since
-- one credential can hold only one row. A unique index spanning users would go further and
-- be actively worse: it would turn an INSERT into an oracle for whether some other account
-- had already used a given salt. A collision between two unrelated credentials is harmless
-- anyway — the wrapping key also depends on the authenticator's own PRF key.
