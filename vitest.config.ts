import { defineConfig } from 'vitest/config'

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
        test: {
          name: 'web-client',
          include: ['apps/web/test/**/*.client.test.ts'],
          environment: 'jsdom',
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
