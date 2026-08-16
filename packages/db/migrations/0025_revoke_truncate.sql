-- Take TRUNCATE away from `anon` and `authenticated` on every table, because it is the one
-- verb row level security cannot filter.
--
-- WHAT WAS WRONG. Supabase's default ACL for a new table in `public` is `arwdDxtm` for BOTH
-- `anon` and `authenticated` — verified against pg_default_acl on the live project, where two
-- rows carry it (owner `postgres` and owner `supabase_admin`). Spelled out that is INSERT,
-- SELECT, UPDATE, DELETE, **TRUNCATE**, REFERENCES, TRIGGER and MAINTAIN. So all sixteen
-- tables in this schema, `events` and `cloaked_fields` among them, granted TRUNCATE to an
-- UNAUTHENTICATED role.
--
-- WHY THAT IS DIFFERENT FROM THE DML SITTING BESIDE IT. Every DML verb here is harmless
-- because RLS filters it: `anon` holds INSERT and DELETE on `events` too, and gets nowhere,
-- since every policy in this schema is `to authenticated` and a row nobody's policy admits is
-- a row that cannot be touched. TRUNCATE is not row-scoped. There is no per-row decision for
-- a policy to make, so `force row level security` plus a `using (false)` policy does not stop
-- it — only the absent privilege does. Confirmed in PGlite: a table locked down exactly that
-- way was emptied by `truncate` as `authenticated`.
--
-- HOW BAD, HONESTLY. Latent, not open. PostgREST exposes no TRUNCATE verb, there is no RPC
-- that truncates, and `anon` is NOLOGIN — it is assumed by `authenticator` after a JWT check,
-- so the anon key does not buy a SQL prompt. Nothing today can reach it. It is written down
-- and fixed anyway because the blast radius is the entire database for every user, the fix
-- costs four lines, and "unreachable through the interface we happen to ship" is the same
-- reasoning that made 0009's hole survive two migrations.
--
-- REFERENCES, TRIGGER AND MAINTAIN GO TOO. All three are inert today — they need CREATE on
-- the schema, which neither role has — so this is not a second finding, just the same
-- allowlist argument 0024 makes: state what a caller MAY do rather than subtracting the
-- verbs you happened to think of. MAINTAIN is exactly the verb that argument is about. It
-- did not exist before PostgreSQL 17, and it arrived pre-granted.
--
-- WHAT SURVIVES: SELECT, INSERT, UPDATE, DELETE. Every one of them is mediated by a policy,
-- which is the design, and taking them away would break every read and write in the product.
--
-- WHAT THIS MIGRATION CANNOT DO, and why the test is the real backstop. `alter default
-- privileges` only changes defaults belonging to the role that runs it. Migrations run as
-- `postgres`, so the block below fixes the `postgres` row; the `supabase_admin` row is not
-- ours to alter from here and stays permissive. A table created by a Supabase-managed process
-- would therefore still arrive with TRUNCATE. That is why `security-posture.test.ts` sweeps
-- for it on every table rather than trusting this migration to have made it impossible — the
-- same posture as the anon EXECUTE sweep, and for the same reason: 0009 claimed to have made
-- new functions safe by default and was wrong, and the sweep is what actually held.
--
-- NOT A DATA MIGRATION. Nothing is read, written or dropped here. Revoking a privilege that
-- nothing has ever exercised changes no row.

revoke truncate, references, trigger, maintain
  on all tables in schema public
  from anon, authenticated;

-- New tables created by this role from now on. See the caveat above about `supabase_admin`.
alter default privileges in schema public
  revoke truncate, references, trigger, maintain on tables from anon, authenticated;
