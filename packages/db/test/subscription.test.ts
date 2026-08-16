import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { USER_A, USER_B, createTestDb, type TestDb } from './harness.js'

/**
 * subscriptions (0024) — the plan a workspace is on.
 *
 * THE ASYMMETRY IS THE FEATURE, so these tests come in two halves: the owner can READ their
 * plan, and the owner cannot WRITE it. Either half alone is a different, useless table — a
 * plan nobody can read is not a plan, and a plan the user can set is not billing.
 *
 * NO `hint` SLUGS HERE, and that is not an oversight. Every other RPC test in this directory
 * asserts on `error.hint`, because hints come from `raise exception ... using hint = ...`
 * inside a plpgsql function and are the stable contract apps/web/src/lib/rpc-error.ts
 * matches on. 0024 adds no function at all, so there is nothing to raise one. The equivalent
 * discipline is passkey-wrap.test.ts's: assert on CONSTRAINT and POLICY names, never on
 * Postgres prose, which is localised and version-dependent.
 *
 * `db.raw` stands in throughout for the billing role that does not exist yet (ADR 0007). It
 * is the superuser here, which is stronger than that role will be, so a test that needs raw
 * to set something up is showing you exactly the privilege the webhook will need.
 */

describe('the plan a workspace is on', () => {
  let db: TestDb
  let ws: string
  let wsB: string

  beforeAll(async () => {
    db = await createTestDb()
    await db.createUser(USER_A, 'a@example.test')
    await db.createUser(USER_B, 'b@example.test')

    const a = await db.as(
      USER_A,
      'insert into public.workspaces (owner_id) values ($1) returning id',
      [USER_A],
    )
    ws = a.rows[0]!['id'] as string

    const b = await db.as(
      USER_B,
      'insert into public.workspaces (owner_id) values ($1) returning id',
      [USER_B],
    )
    wsB = b.rows[0]!['id'] as string
  })

  afterAll(async () => {
    await db.close()
  })

  describe('reading it', () => {
    it('has no row for a brand-new workspace, which is what free MEANS', async () => {
      // Pinned at the schema rather than left to the `??` in apps/web/src/server/plan.ts,
      // so "absence is free" is stated in the two places that have to agree about it. A
      // bootstrap row would make this test read `[{ plan: 'free' }]`, which is why it is
      // written as the absence and not as the value.
      const { rows } = await db.as(
        USER_A,
        'select plan from public.subscriptions where workspace_id = $1',
        [ws],
      )
      expect(rows).toEqual([])
    })

    it('reads back a plan written by something that is not the user', async () => {
      // The read half. Without this the table could be write-proof by being unreachable,
      // which is not the feature — it is a bug that passes every test below.
      await db.raw(`insert into public.subscriptions (workspace_id, plan) values ($1, 'pro')`, [
        ws,
      ])

      const { rows } = await db.as(
        USER_A,
        'select plan from public.subscriptions where workspace_id = $1',
        [ws],
      )
      expect(rows).toEqual([{ plan: 'pro' }])
    })

    it('makes another user’s subscription look missing, not forbidden', async () => {
      // Same information posture as `workspace_not_found` everywhere else: absent, never
      // refused. A refusal would confirm the row exists.
      await db.raw(`insert into public.subscriptions (workspace_id, plan) values ($1, 'pro')`, [
        wsB,
      ])

      const { rows } = await db.as(
        USER_A,
        'select plan from public.subscriptions where workspace_id = $1',
        [wsB],
      )
      expect(rows).toEqual([])
    })

    it('hides every subscription from an unauthenticated caller', async () => {
      // asUnauthenticated, not asAnon: this is the `anon` ROLE with its own grants, which
      // is what an HTTP request with no session actually runs as. The .catch spelling
      // asserts the OUTCOME rather than which of the two gates produced it — the harness
      // may deny the privilege where production returns zero rows, and both are correct.
      const { rows } = await db
        .asUnauthenticated('select workspace_id from public.subscriptions')
        .catch(() => ({ rows: [] as Record<string, unknown>[] }))
      expect(rows).toEqual([])
    })
  })

  describe('not writing it', () => {
    it('REFUSES an update of the account holder’s own plan', async () => {
      // THE test. Their workspace, their row, their session, and it is still refused. If
      // this ever goes green for the wrong reason the whole feature is decorative, so it is
      // worth re-proving by hand after any change to this table: remove the revoke in 0024
      // and it must fail, widen the policy to `for all` and it must fail.
      await expect(
        db.as(USER_A, `update public.subscriptions set plan = 'pro' where workspace_id = $1`, [
          ws,
        ]),
      ).rejects.toThrow(/permission denied/iu)
    })

    it('REFUSES an insert, so a plan cannot be minted either', async () => {
      // Refusing UPDATE alone would be pointless while the user can INSERT their own row —
      // and for every free account there IS no row, so insert is the cheaper attack.
      const fresh = await db.as(
        USER_A,
        'insert into public.workspaces (owner_id) values ($1) returning id',
        [USER_A],
      )
      await expect(
        db.as(
          USER_A,
          `insert into public.subscriptions (workspace_id, plan) values ($1, 'pro')`,
          [fresh.rows[0]!['id'] as string],
        ),
      ).rejects.toThrow(/permission denied/iu)
    })

    it('REFUSES a delete, so a plan cannot be dropped to dodge a future limit', async () => {
      await expect(
        db.as(USER_A, 'delete from public.subscriptions where workspace_id = $1', [ws]),
      ).rejects.toThrow(/permission denied/iu)
    })

    it('is stopped by BOTH gates, independently', async () => {
      // 0024 states that the missing policies and the revoked privileges are two separate
      // locks. A test that only ever sees "permission denied" cannot tell which one is
      // holding, and would stay green if the policy half were deleted. So: hand the
      // privileges back, simulating a future migration that re-grants them carelessly, and
      // watch the POLICY hold on its own.
      await db.raw('grant insert, update, delete on public.subscriptions to authenticated')

      try {
        // No policy for UPDATE means the row is invisible to it: zero rows affected rather
        // than an error. Silent, which is exactly why the revoke exists as well.
        const updated = await db.as(
          USER_A,
          `update public.subscriptions set plan = 'pro' where workspace_id = $1 returning workspace_id`,
          [ws],
        )
        expect(updated.rows).toEqual([])

        // INSERT is the loud one: a WITH CHECK that no policy grants is a refusal.
        const fresh = await db.as(
          USER_A,
          'insert into public.workspaces (owner_id) values ($1) returning id',
          [USER_A],
        )
        await expect(
          db.as(
            USER_A,
            `insert into public.subscriptions (workspace_id, plan) values ($1, 'pro')`,
            [fresh.rows[0]!['id'] as string],
          ),
        ).rejects.toThrow(/row-level security/iu)
      } finally {
        await db.raw('revoke insert, update, delete on public.subscriptions from authenticated')
      }
    })

    it('REFUSES a truncate, which no policy could have stopped', async () => {
      /*
       * The verb the first draft of 0024 left behind. Supabase's default ACL for a new
       * public table is `authenticated=arwdDxtm`, so `revoke insert, update, delete` leaves
       * TRUNCATE, REFERENCES, TRIGGER and MAINTAIN in place — and TRUNCATE is the one verb
       * row level security CANNOT filter. RLS forced plus a `using (false)` policy does not
       * stop it; only the absent privilege does.
       *
       * Nothing reaches it through PostgREST today, so this is defense in depth. But the
       * revoke IS the defense-in-depth gate, and the allowlist spelling in 0024 is what
       * stops a verb nobody has heard of yet from arriving pre-granted. MAINTAIN is exactly
       * such a verb, new in PG17.
       */
      await expect(db.as(USER_A, 'truncate public.subscriptions')).rejects.toThrow(
        /permission denied/iu,
      )
    })

    it('grants the account holder SELECT and nothing else', async () => {
      // Stated POSITIVELY, so a privilege that did not exist when this was written cannot
      // slip in underneath it. Anything but ['SELECT'] is a regression.
      const { rows } = await db.raw(`
        select privilege_type from information_schema.table_privileges
        where table_schema = 'public' and table_name = 'subscriptions'
          and grantee = 'authenticated'
        order by privilege_type
      `)
      expect(rows.map((r) => r['privilege_type'])).toEqual(['SELECT'])
    })

    it('grants the anon role nothing at all', async () => {
      const { rows } = await db.raw(`
        select privilege_type from information_schema.table_privileges
        where table_schema = 'public' and table_name = 'subscriptions' and grantee = 'anon'
      `)
      expect(rows).toEqual([])
    })

    it('gives authenticated exactly one policy, and its verb is SELECT', async () => {
      // The structural statement, which fails the day anyone adds `for all` even if the
      // runtime tests above were somehow satisfied. `cmd` is 'r' for SELECT in pg_policy;
      // pg_policies spells it out.
      // `roles` as well as `cmd`: the house rule is always `to authenticated`, and a policy
      // accidentally written `to public` would keep a cmd-only assertion green.
      //
      // SCOPED TO `authenticated` SINCE 0028, which added a `billing_writer` role with write
      // policies of its own. This assertion used to say "exactly one policy on the table" and
      // it CAUGHT that change, which is the reason it was written — but the guarantee it
      // exists to protect was never "one policy", it was "the account holder cannot write
      // their own plan". So it now names the role it is about, and the full set including
      // billing_writer is pinned separately below rather than left unstated.
      const { rows } = await db.raw(`
        select policyname, cmd, roles::text as roles from pg_policies
        where schemaname = 'public' and tablename = 'subscriptions'
          and roles::text like '%authenticated%'
        order by policyname
      `)
      expect(rows).toEqual([
        { policyname: 'subscriptions_select', cmd: 'SELECT', roles: '{authenticated}' },
      ])
    })

    it('gives the billing writer named verbs, and never DELETE', async () => {
      // The whole policy set, declared. Anything added to this table has to be written down
      // here, which is what the old "exactly one policy" assertion bought and what a
      // role-scoped filter would otherwise give away.
      const { rows } = await db.raw(`
        select policyname, cmd, roles::text as roles from pg_policies
        where schemaname = 'public' and tablename = 'subscriptions'
        order by policyname
      `)
      expect(rows).toEqual([
        { policyname: 'subscriptions_amend', cmd: 'UPDATE', roles: '{billing_writer}' },
        { policyname: 'subscriptions_read_own_writes', cmd: 'SELECT', roles: '{billing_writer}' },
        { policyname: 'subscriptions_select', cmd: 'SELECT', roles: '{authenticated}' },
        { policyname: 'subscriptions_write', cmd: 'INSERT', roles: '{billing_writer}' },
      ])

      // No DELETE policy AND no DELETE grant. A writer that can delete can cover its tracks,
      // and a cancellation is an UPDATE to plan = 'free', never a removal.
      const { rows: grants } = await db.raw(`
        select privilege_type from information_schema.table_privileges
        where table_schema = 'public' and table_name = 'subscriptions'
          and grantee = 'billing_writer'
        order by privilege_type
      `)
      expect(grants).toEqual([
        { privilege_type: 'INSERT' },
        { privilege_type: 'SELECT' },
        { privilege_type: 'UPDATE' },
      ])
    })

    it('keeps the billing writer out of every table but its own two', async () => {
      // ADR 0007's central claim, as a test rather than a paragraph: the role cannot resolve
      // a customer to a workspace by reading `workspaces`, which is why the mapping lives in
      // `subscriptions` itself. The natural fix under time pressure is to widen this role —
      // this is what fails when someone does.
      const { rows } = await db.raw(`
        select table_name, privilege_type from information_schema.table_privileges
        where table_schema = 'public' and grantee = 'billing_writer'
          and table_name not in ('subscriptions', 'billing_events')
      `)
      expect(rows).toEqual([])
    })

    it('cannot log in until a password is set out of band', async () => {
      // The migration creates the role NOLOGIN and with no password, because a password in a
      // committed migration is a password in the git history forever. Until the out-of-band
      // `alter role ... login password` runs, the role exists and cannot connect — the right
      // default for a role that ships before its handler.
      const { rows } = await db.raw(`
        select rolcanlogin from pg_roles where rolname = 'billing_writer'
      `)
      expect(rows).toEqual([{ rolcanlogin: false }])
    })

    it('adds no function, so the anon sweep has nothing new to carry', async () => {
      // States the no-RPC decision as something that fails if it is silently reversed.
      const { rows } = await db.raw(`
        select p.proname from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'private') and p.proname like '%subscription%'
      `)
      expect(rows).toEqual([])
    })
  })

  describe('the shape of a row', () => {
    it('refuses a tier the catalog does not have', async () => {
      // Through raw, because only a privileged writer can insert at all — the constraint
      // has to hold for the webhook, which is the only thing that will ever exercise it.
      const fresh = await db.as(
        USER_A,
        'insert into public.workspaces (owner_id) values ($1) returning id',
        [USER_A],
      )
      await expect(
        db.raw(`insert into public.subscriptions (workspace_id, plan) values ($1, 'enterprise')`, [
          fresh.rows[0]!['id'] as string,
        ]),
      ).rejects.toThrow(/subscriptions_plan_known/u)
    })

    it('allows exactly one plan per workspace', async () => {
      await expect(
        db.raw(`insert into public.subscriptions (workspace_id, plan) values ($1, 'free')`, [ws]),
      ).rejects.toThrow(/subscriptions_pkey/u)
    })

    it('defaults to free, so a partial write cannot invent a paid account', async () => {
      const fresh = await db.as(
        USER_A,
        'insert into public.workspaces (owner_id) values ($1) returning id',
        [USER_A],
      )
      const id = fresh.rows[0]!['id'] as string
      await db.raw('insert into public.subscriptions (workspace_id) values ($1)', [id])

      const { rows } = await db.as(
        USER_A,
        'select plan from public.subscriptions where workspace_id = $1',
        [id],
      )
      expect(rows).toEqual([{ plan: 'free' }])
    })

    it('goes away with the workspace it belongs to, deleted BY THE USER', async () => {
      /*
       * Two things at once, and the second is the one worth writing down.
       *
       * The throwaway-account recipe in CLAUDE.md relies on the cascade taking everything, so
       * a subscription left behind would be a row pointing at a workspace that is gone.
       *
       * But this runs as USER_A rather than through db.raw, because it is the ONE WAY A USER
       * CAN DESTROY THEIR OWN PLAN ROW. `workspaces_delete` (0002) lets an owner delete their
       * workspace, and a referential action runs internally — checking neither RLS nor
       * privileges on the referencing table, both of which refuse a direct delete three tests
       * up. Doing it through raw would demonstrate the cascade while hiding the capability.
       *
       * Harmless today: it costs the whole workspace and every event in it, and there is no
       * limit to dodge. It stops being harmless once Stripe is wired, which is why ADR 0007
       * records that deleting an account must cancel its provider subscription first.
       */
      const fresh = await db.as(
        USER_A,
        'insert into public.workspaces (owner_id) values ($1) returning id',
        [USER_A],
      )
      const id = fresh.rows[0]!['id'] as string
      await db.raw(`insert into public.subscriptions (workspace_id, plan) values ($1, 'pro')`, [id])

      await db.as(USER_A, 'delete from public.workspaces where id = $1', [id])

      const { rows } = await db.raw(
        'select workspace_id from public.subscriptions where workspace_id = $1',
        [id],
      )
      expect(rows).toEqual([])
    })

    it('moves updated_at when the billing role writes, which nothing else proves', async () => {
      /*
       * The touch trigger exists for a writer that does not exist yet, so without this its
       * first real firing would be a production Stripe webhook — the wrong half of the trade
       * for something added now on the grounds that it is cheaper than remembering later.
       * db.raw is the stand-in for that role throughout this file.
       */
      const fresh = await db.as(
        USER_A,
        'insert into public.workspaces (owner_id) values ($1) returning id',
        [USER_A],
      )
      const id = fresh.rows[0]!['id'] as string
      await db.raw('insert into public.subscriptions (workspace_id) values ($1)', [id])
      // Back-date created_at/updated_at so the comparison cannot depend on clock resolution.
      await db.raw(
        `update public.subscriptions
           set created_at = now() - interval '1 day', updated_at = now() - interval '1 day'
         where workspace_id = $1`,
        [id],
      )

      await db.raw(`update public.subscriptions set plan = 'pro' where workspace_id = $1`, [id])

      const { rows } = await db.raw(
        'select updated_at > created_at as touched from public.subscriptions where workspace_id = $1',
        [id],
      )
      expect(rows).toEqual([{ touched: true }])
    })
  })
})
