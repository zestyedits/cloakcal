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
  end
  $$;

  grant usage on schema public to authenticated;
  grant usage on schema auth to authenticated;
  grant select on auth.users to authenticated;

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
] as const

export interface TestDb {
  /** Run SQL as the Postgres superuser, bypassing RLS. Use only for setup/teardown. */
  raw(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
  /** Run SQL as a specific signed-in user, with RLS enforced. */
  as(userId: string, sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
  /** Run SQL as an anonymous caller (no JWT subject), with RLS enforced. */
  asAnon(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
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
    asAnon: (sql, params) => runAs(null, sql, params),
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
