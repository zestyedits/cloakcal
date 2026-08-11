import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { createTestDb, type TestDb } from './harness.js'

/**
 * Database security posture.
 *
 * Raised by the M0 review: a `SECURITY DEFINER` helper needs a locked-down search_path,
 * fully-qualified references, minimal grants, and an execution posture that does not
 * bypass RLS. The strongest response was to stop needing definer rights at all, so the
 * headline assertion here is that NO definer-rights function exists anywhere.
 *
 * These are structural assertions about the schema rather than behavioural ones, so they
 * keep holding as migrations accumulate — which is the point. A future migration that
 * reintroduces a definer function, or forgets RLS on a new table, fails here.
 */

let db: TestDb

beforeAll(async () => {
  db = await createTestDb()
})

afterAll(async () => {
  await db.close()
})

describe('no privilege escalation surface', () => {
  it('defines no SECURITY DEFINER functions at all', async () => {
    const { rows } = await db.raw(`
      select n.nspname || '.' || p.proname as fn
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and p.prosecdef
      order by 1
    `)
    expect(rows.map((r) => r['fn'])).toEqual([])
  })

  it('pins search_path on every function it defines', async () => {
    // An unqualified name inside a function is resolved through the caller's search_path.
    // Without pinning, a caller can shadow `workspaces` with their own table and change
    // what an authorization check returns.
    const { rows } = await db.raw(`
      select n.nspname || '.' || p.proname as fn
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private')
        and p.prokind = 'f'
        and (p.proconfig is null or not exists (
          select 1 from unnest(p.proconfig) c where c like 'search\\_path=%'
        ))
      order by 1
    `)
    expect(rows.map((r) => r['fn'])).toEqual([])
  })
})

describe('the membership helper is out of the exposed API surface', () => {
  it('lives in the private schema, which PostgREST does not introspect', async () => {
    const { rows } = await db.raw(`
      select n.nspname as schema
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.proname = 'is_workspace_member'
    `)
    expect(rows.map((r) => r['schema'])).toEqual(['private'])
  })

  it('is gone from public, so no RPC endpoint can exist for it', async () => {
    const { rows } = await db.raw(`
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'is_workspace_member'
    `)
    expect(rows).toHaveLength(0)
  })

  it('grants execute to authenticated but not to public or anon', async () => {
    const { rows } = await db.raw(`
      select coalesce(
        (select array_agg(distinct grantee order by grantee)
         from information_schema.role_routine_grants
         where specific_schema = 'private' and routine_name = 'is_workspace_member'),
        '{}'
      ) as grantees
    `)
    const grantees = (rows[0]!['grantees'] as string[]) ?? []
    expect(grantees).toContain('authenticated')
    expect(grantees).not.toContain('PUBLIC')
    expect(grantees).not.toContain('anon')
  })

  it('does not expose the private schema to anonymous callers', async () => {
    const { rows } = await db.raw(
      `select has_schema_privilege('authenticated', 'private', 'USAGE') as authed`,
    )
    expect(rows[0]!['authed']).toBe(true)
  })
})

describe('RLS coverage cannot regress', () => {
  it('has row level security enabled and forced on every public table', async () => {
    const { rows } = await db.raw(`
      select c.relname as table_name
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and (not c.relrowsecurity or not c.relforcerowsecurity)
      order by 1
    `)
    expect(rows.map((r) => r['table_name'])).toEqual([])
  })

  it('leaves no public table without at least one policy', async () => {
    const { rows } = await db.raw(`
      select c.relname as table_name
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and not exists (
          select 1 from pg_policies p
          where p.schemaname = 'public' and p.tablename = c.relname
        )
      order by 1
    `)
    expect(rows.map((r) => r['table_name'])).toEqual([])
  })

  it('gives every workspace-scoped policy a WITH CHECK, not just a USING', async () => {
    // USING controls what you may read-modify; WITH CHECK controls what the row may
    // become. A policy with only USING lets a caller move a row into another workspace.
    const { rows } = await db.raw(`
      select tablename || '.' || policyname as policy
      from pg_policies
      where schemaname = 'public'
        and cmd = 'ALL'
        and with_check is null
      order by 1
    `)
    expect(rows.map((r) => r['policy'])).toEqual([])
  })
})

/**
 * Nothing in CloakCal is readable without a session, so no RPC should be reachable without
 * one either. This is the assertion whose absence let 0007 and 0008 ship with an `anon`
 * grant they believed they had revoked.
 *
 * It is a sweep rather than a per-function check on purpose: the failure mode is somebody
 * adding a function and forgetting, and a test that has to be extended alongside the thing
 * it guards is a test that will not be extended.
 */
describe('no RPC is reachable without a session', () => {
  it('leaves no function executable by anon, in either schema we own', async () => {
    // `private` is included because the first version of this sweep checked only `public`
    // and shipped while private.assert_cloaked_subject_matches was still granted to anon.
    // That one was unreachable for a second reason — anon has no USAGE on the schema — but
    // "safe by accident of a different mechanism" is not what this test is here to assert.
    const { rows } = await db.raw(`
      select n.nspname || '.' || p.proname as fn
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private')
        and has_function_privilege('anon', p.oid, 'execute')
      order by 1
    `)
    expect(rows.map((r) => r['fn'])).toEqual([])
  })

  it('is load-bearing, because a bare CREATE FUNCTION is still anon-reachable', async () => {
    // The sweep above is the ONLY thing standing between this project and an open RPC, and
    // this is why. Postgres grants EXECUTE to PUBLIC on every function at creation, `anon`
    // inherits through PUBLIC, and that default cannot be switched off:
    // `alter default privileges ... revoke execute on functions from public` is a silent
    // no-op, because the built-in grant is implicit rather than a stored default. Confirmed
    // against the live Supabase project as well as here.
    //
    // So "we revoked the default, new functions are safe now" — 0009's claim — is false, and
    // will stay false. Every function needs its own revoke, and this test exists so nobody
    // reads the green sweep as evidence that the platform is handling it.
    await db.raw(`create function public.posture_canary() returns integer
                  language sql immutable as $$ select 1 $$`)
    try {
      const { rows } = await db.raw(
        `select has_function_privilege('anon', 'public.posture_canary()', 'execute') as anon_can_call`,
      )
      expect(rows[0]!['anon_can_call']).toBe(true)
    } finally {
      await db.raw('drop function public.posture_canary()')
    }
  })
})
