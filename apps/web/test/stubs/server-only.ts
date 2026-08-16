/**
 * A stand-in for the `server-only` package, for vitest.
 *
 * `server-only` is not a dependency of this workspace and never has been: Next aliases the
 * bare specifier to its own compiled copy during a build, so `import 'server-only'` resolves
 * inside `next build` and nowhere else. That is why, until billing, not one test in this repo
 * imported a module from `apps/web/src/server/` that carried the directive — the import would
 * simply fail to resolve.
 *
 * THIS DOES NOT WEAKEN THE BOUNDARY IT STUBS OUT. The real enforcement of "a client bundle
 * may not contain this module" is Next's bundler, which errors at build time, and `pnpm build`
 * runs before `pnpm test` on a fresh clone precisely so a build-time guarantee is checked by
 * a build. A test runner asserting that an import throws would be asserting a property of the
 * package rather than a property of this app.
 *
 * What DOES belong in a test is the direction the bundler cannot see from here — that no
 * `'use client'` module imports a server billing module in the first place, and that exactly
 * one file opens a write-capable database connection. `billing-boundary.server.test.ts` owns
 * both, by reading source rather than by resolving imports.
 */
export {}
