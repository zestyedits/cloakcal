import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

/**
 * Postgres test harness backed by PGlite (real Postgres, compiled to WASM).
 *
 * Why not the Supabase CLI: it requires Docker, which is not installed on this
 * machine and would be a heavy dependency for CI. PGlite runs the genuine Postgres
 * planner and executor, so RLS, policies, constraints and triggers behave exactly as
 * they do in production — which is the whole point. A mocked query layer would prove
 * nothing about whether a policy actually blocks a cross-workspace read.
 *
 * The one thing PGlite does not give us is Supabase's `auth` schema, so we shim the
 * two pieces our policies depend on: `auth.users` and `auth.uid()`. The shim below
 * mirrors Supabase's real implementation of `auth.uid()` rather than approximating it.
 */

const migrationPath = (name: string) =>
  fileURLToPath(new URL(`../migrations/${name}`, import.meta.url))

/**
 * Supabase-compatible auth shim.
 *
 * `authenticated` is created NOLOGIN and, critically, is NOT a superuser: Postgres
 * superusers bypass RLS entirely, so a test running as `postgres` would pass no matter
 * how broken the policies were. Every assertion in rls.test.ts runs under this role.
 */
const AUTH_SHIM = /* sql */ `
  create schema if not exists auth;

  create table if not exists auth.users (
    id    uuid primary key,
    email text unique
  );

  create or replace function auth.uid()
  returns uuid
  language sql
  stable
  as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $$;

  do $$
  begin
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
      create role authenticated nologin;
    end if;
    -- Supabase's UNAUTHENTICATED role. It was missing here, and its absence hid a real
    -- production gap: 0007 and 0008 revoked execute from PUBLIC and assumed that locked
    -- them down, while Supabase's default privileges had separately granted execute to
    -- anon. With no anon role in the harness there was nothing to assert against, so
    -- "is not callable anonymously" passed by testing the wrong thing. See migration 0009.
    if not exists (select 1 from pg_roles where rolname = 'anon') then
      create role anon nologin;
    end if;
  end
  $$;

  grant usage on schema public to authenticated;
  grant usage on schema auth to authenticated;
  grant select on auth.users to authenticated;
  grant usage on schema public to anon;

  -- DEFAULT privileges, applied BEFORE any migration runs.
  --
  -- This mirrors Supabase, where new tables become reachable by \`authenticated\` as they
  -- are created. The earlier approach — one GRANT sweep after 0001 — silently left every
  -- table added by a later migration unreachable, and a hardening migration that revokes
  -- a privilege (audit_log) would be undone by any later sweep. Default privileges avoid
  -- both failure modes: grants land at creation time, and explicit REVOKEs stay revoked.
  alter default privileges in schema public
    grant select, insert, update, delete on tables to authenticated;
  alter default privileges in schema public
    grant usage, select on sequences to authenticated;

  -- Supabase grants EXECUTE on new functions to anon by default. Mirrored here so the
  -- harness reproduces the permissive starting point rather than a stricter fiction — a
  -- migration that claims to revoke a privilege can only be tested against a database that
  -- actually granted it.
  alter default privileges in schema public
    grant execute on functions to anon, authenticated;
`

/**
 * Migrations, applied in order. Privileges come from the default-privilege grants in the
 * shim above, so adding a migration here needs no accompanying GRANT bookkeeping.
 */
const MIGRATIONS = [
  '0001_init.sql',
  '0002_rls.sql',
  '0003_private_schema.sql',
  '0004_m0_review_hardening.sql',
  '0005_route_token_128bit.sql',
  '0006_root_key_wraps.sql',
  '0007_create_cloaked_event.sql',
  '0008_trash_cloaked_event.sql',
  '0009_revoke_rpc_from_anon.sql',
  '0010_lock_down_function_grants.sql',
  '0011_update_cloaked_event.sql',
  '0012_trash_event_hints.sql',
  '0013_split_cloaked_event.sql',
  '0014_cancel_occurrence.sql',
  '0015_cloak_subject_contacts.sql',
  '0016_contacts_and_groups.sql',
  '0017_contact_and_rule_rpcs.sql',
  '0018_workspace_prefs.sql',
  '0019_update_calendar.sql',
  '0020_contact_group_rpcs.sql',
  '0021_create_calendar.sql',
] as const

export interface QueryResult {
  rows: Record<string, unknown>[]
}

export type Executor = (sql: string, params?: unknown[]) => Promise<QueryResult>

export interface TestDb {
  /** Run SQL as the Postgres superuser, bypassing RLS. Use only for setup/teardown. */
  raw(sql: string, params?: unknown[]): Promise<QueryResult>
  /** Run SQL as a specific signed-in user, with RLS enforced. */
  as(userId: string, sql: string, params?: unknown[]): Promise<QueryResult>
  /** Run SQL as an anonymous caller (no JWT subject), with RLS enforced. */
  asAnon(sql: string, params?: unknown[]): Promise<QueryResult>
  /**
   * Run SQL as Supabase's `anon` ROLE — an unauthenticated HTTP request.
   *
   * Different from `asAnon`, and the difference is the point. `asAnon` is the
   * `authenticated` role with no JWT subject; this is the role PostgREST actually uses when
   * nobody is signed in, and it carries its own grants. Privilege assertions belong here.
   */
  asUnauthenticated(sql: string, params?: unknown[]): Promise<QueryResult>
  /**
   * Run a callback inside a real transaction, as a signed-in user.
   *
   * Identity is applied with `SET LOCAL`, so it reverts at commit or rollback and cannot
   * bleed into the next test. Without this, atomicity claims could not be tested at all —
   * a partial write would look identical to a successful one.
   */
  asTransaction<T>(userId: string, fn: (tx: Executor) => Promise<T>): Promise<T>
  /** Create an auth.users row and return its id. */
  createUser(id: string, email: string): Promise<string>
  close(): Promise<void>
}

export async function createTestDb(): Promise<TestDb> {
  const pg = new PGlite()
  await pg.exec(AUTH_SHIM)

  for (const name of MIGRATIONS) {
    await pg.exec(await readFile(migrationPath(name), 'utf8'))
  }

  const runAs = async (subject: string | null, sql: string, params: unknown[] = []) => {
    // set_config(..., is_local => false) keeps the setting for the session; PGlite is a
    // single connection, so we reset both role and claim after every statement to stop
    // one test's identity leaking into the next.
    await pg.query(`select set_config('request.jwt.claim.sub', $1, false)`, [subject ?? ''])
    await pg.exec('set role authenticated')
    try {
      const result = await pg.query<Record<string, unknown>>(sql, params)
      return { rows: result.rows }
    } finally {
      await pg.exec('reset role')
      await pg.query(`select set_config('request.jwt.claim.sub', '', false)`)
    }
  }

  return {
    async raw(sql, params = []) {
      const result = await pg.query<Record<string, unknown>>(sql, params)
      return { rows: result.rows }
    },
    as: (userId, sql, params) => runAs(userId, sql, params),

    async asUnauthenticated(sql, params = []) {
      await pg.query(`select set_config('request.jwt.claim.sub', '', false)`)
      await pg.exec('set role anon')
      try {
        const result = await pg.query<Record<string, unknown>>(sql, params)
        return { rows: result.rows }
      } finally {
        await pg.exec('reset role')
      }
    },

    asAnon: (sql, params) => runAs(null, sql, params),

    async asTransaction<T>(userId: string, fn: (tx: Executor) => Promise<T>): Promise<T> {
      const result = await pg.transaction(async (tx) => {
        // SET LOCAL scopes both settings to this transaction: they revert on COMMIT and on
        // ROLLBACK alike, so a rolled-back test cannot leave an identity behind.
        await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId])
        await tx.exec('set local role authenticated')

        return fn(async (sql, params = []) => {
          const r = await tx.query<Record<string, unknown>>(sql, params)
          return { rows: r.rows }
        })
      })
      return result as T
    },
    async createUser(id, email) {
      await pg.query('insert into auth.users (id, email) values ($1, $2)', [id, email])
      return id
    },
    async close() {
      await pg.close()
    },
  }
}

/** Deterministic UUIDs so failures are reproducible and readable in diffs. */
export const USER_A = '00000000-0000-4000-8000-00000000000a'
export const USER_B = '00000000-0000-4000-8000-00000000000b'
