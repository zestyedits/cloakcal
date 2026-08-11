import { defineConfig, devices } from '@playwright/test'

/**
 * E2E, accessibility and visual-regression config.
 *
 * WHY THIS RUNS AGAINST THE DEV SERVER, DELIBERATELY.
 *
 * The first version pointed at `next start`. Every functional test failed, because
 * `next start` is a production build and getDevRootKey() refuses to issue a key when
 * NODE_ENV is production. That is the gate working — a development key must not unlock a
 * production bundle — so the fix is emphatically NOT to relax it for testing. Weakening a
 * structural guarantee to make a test convenient is how guarantees quietly stop being real.
 *
 * The coverage therefore splits along the line the gate already draws:
 *
 *   Production artifacts — initial HTML, RSC/Flight payload, every chunk, caches —
 *     apps/web/test/build-output.leak.test.ts, run against a real `next build`.
 *     It also proves prod renders PLACEHOLDERS, i.e. that the gate holds in production.
 *
 *   Runtime client behaviour — storage, error reports, console, network, a11y, visuals —
 *     here, against `next dev`, where the development key is legitimate. These surfaces
 *     are client-side and behave the same either way.
 *
 * Between them both halves are covered, and neither required loosening the gate.
 */

const PORT = 3100
const BASE_URL = `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  // Conditional spread rather than `: undefined` — exactOptionalPropertyTypes treats an
  // explicit undefined as a distinct value from an absent key.
  ...(process.env['CI'] ? { workers: 1 } : {}),
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    // Deterministic clock and locale so visual baselines do not drift by machine.
    timezoneId: 'America/New_York',
    locale: 'en-US',
  },

  projects: [
    // Functional and leak specs run at BOTH breakpoints. Visual and a11y are pinned to a
    // single project each: screenshot baselines are per-project files, so letting every
    // project claim them would demand one baseline set per device for no added coverage.
    {
      name: 'mobile',
      testMatch: /(leak|view-as)\.spec\.ts/,
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'desktop',
      testMatch: /(leak|view-as)\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
    {
      name: 'a11y',
      testMatch: /a11y\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
    {
      name: 'visual',
      testMatch: /visual\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
  ],

  expect: {
    toHaveScreenshot: {
      // Font rasterisation differs slightly across machines; this tolerates that without
      // tolerating a layout change.
      maxDiffPixelRatio: 0.02,
      animations: 'disabled',
    },
  },

  webServer: {
    command: 'pnpm --filter @cloakcal/web dev --port 3100',
    url: BASE_URL,
    reuseExistingServer: !process.env['CI'],
    timeout: 180_000,
    env: {
      NEXT_PUBLIC_CLOAKCAL_DEV_UNLOCK: '1',
    },
  },
})
