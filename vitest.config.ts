import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * The `@/…` alias, which vitest does not get from tsconfig on its own.
 *
 * Needed once `middleware.ts` imported `@/lib/csp`: the middleware path tests import the
 * module itself, so an unresolvable alias inside it fails the whole file. Test files here
 * still import relatively — this exists for the SOURCE modules they pull in, which use the
 * app's own convention and should not be rewritten to suit the runner.
 *
 * THE KEY IS `'@'`, NOT `'@/'`, AND THE DIFFERENCE IS NOT COSMETIC. Vite resolves an object
 * alias through @rollup/plugin-alias, whose matcher accepts a string pattern only when the
 * specifier EQUALS it or starts with `pattern + '/'`. Under a `'@/'` key, `@/lib/csp` would
 * have to start with `'@//'`, so the alias matched nothing and every module reaching for one
 * failed to resolve. It shipped that way with the CSP work and took four test FILES down
 * with it — middleware-paths (41 tests), subscription-row and both billing suites — while
 * the summary line still said hundreds passed, because a file that cannot be COLLECTED
 * contributes no failing tests, only a quieter total. That is the same shape as the visual
 * baselines skipping on every platform: the gate reports green by having nothing to check.
 */
const webSrc = fileURLToPath(new URL('./apps/web/src/', import.meta.url))

/**
 * `server-only` is not a dependency of this workspace — Next aliases the bare specifier to
 * its own compiled copy during a build, so it resolves inside `next build` and nowhere else.
 * Without this stub, importing anything from `apps/web/src/server/` that carries the
 * directive fails to resolve, which is why no test did until billing. See the stub's header
 * for why this does not weaken the boundary it stands in for.
 */
const serverOnlyStub = fileURLToPath(
  new URL('./apps/web/test/stubs/server-only.ts', import.meta.url),
)

const webAlias = {
  resolve: { alias: { '@': webSrc, 'server-only': serverOnlyStub } },
}

/**
 * Every declared project MUST contain tests.
 *
 * `passWithNoTests` is deliberately absent: a required check that runs zero tests is not
 * a quality gate, it is a green light with nothing behind it. Projects are therefore
 * declared only once they have tests — `policy` and `policy-vectors-*` arrive with M2,
 * `domain` with M1. The corresponding CI jobs and package scripts land at the same time.
 *
 * policy-vectors-server and policy-vectors-client will deliberately execute the SAME
 * vector files through two entry points. That duplication is the mechanism behind D2: if
 * server redaction and client "View As" ever diverge, one of the two goes red.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'db',
          include: ['packages/db/test/**/*.test.ts'],
          // Leak tests belong to the `leak` project; excluding them keeps each suite
          // running exactly once and keeps `pnpm test:leak` meaningful on its own.
          exclude: ['**/*.leak.test.ts'],
          environment: 'node',
          // PGlite boots a WASM Postgres per suite; generous but bounded.
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'domain',
          include: ['packages/domain/src/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'policy',
          include: ['packages/policy/src/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'policy-vectors-server',
          include: ['packages/policy/test/**/*.server.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'policy-vectors-client',
          include: ['packages/policy/test/**/*.client.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'crypto',
          include: ['packages/crypto/src/**/*.test.ts'],
          environment: 'node',
          // The nonce-reuse property runs 1000 WebCrypto operations; the 5s default is
          // too tight on a loaded machine and made it intermittently flaky.
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'cloak-store-client',
          include: ['packages/cloak-store/src/**/*.client.test.ts'],
          environment: 'jsdom',
        },
      },
      {
        // Deliberately node: proves the store refuses to run where there is no browser.
        test: {
          name: 'cloak-store-server',
          include: ['packages/cloak-store/src/**/*.server.test.ts'],
          environment: 'node',
        },
      },
      {
        ...webAlias,
        test: {
          name: 'web-client',
          include: ['apps/web/test/**/*.client.test.ts'],
          environment: 'jsdom',
        },
      },
      {
        ...webAlias,
        test: {
          // The server half of apps/web — redaction, ranges, the read path. Node, not jsdom,
          // so a test cannot accidentally lean on a browser global the real server lacks.
          name: 'web-server',
          include: ['apps/web/test/**/*.server.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'ui',
          include: ['packages/ui/src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'tools',
          include: ['tools/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'leak',
          include: ['packages/**/*.leak.test.ts', 'apps/**/*.leak.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
})
