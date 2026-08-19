import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

/**
 * Does this platform have visual baselines committed?
 *
 * Playwright names snapshots with the platform suffix, so a Windows-generated baseline and
 * a macOS run never meet. Checking for the suffix is how the visual project knows whether
 * it can run here at all — see the `visual` project below.
 */
function hasVisualBaselines(): boolean {
  const dir = fileURLToPath(new URL('e2e/visual.spec.ts-snapshots/', import.meta.url))
  if (!existsSync(dir)) return false
  return readdirSync(dir).some((file) => file.endsWith(`-${process.platform}.png`))
}

/**
 * The escape hatch that makes bootstrapping a new platform possible at all.
 *
 * Without it the skip below is a closed loop: the visual project ignores itself until
 * baselines for this platform exist, and the documented way to create them is to run the
 * visual project. `pnpm test:visual --update-snapshots` answered "No tests found" on any
 * machine that did not already have baselines — so the instructions in the comment below
 * described a procedure that could never work, and nobody noticed because the only machine
 * with baselines was the one that made them.
 */
function isBootstrappingSnapshots(): boolean {
  return process.argv.includes('--update-snapshots') || process.argv.includes('-u')
}

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
  //
  // TWO on CI, not one. `workers: 1` is Playwright's boilerplate default and was fine at
  // the 91 specs this project started with; at 252 it ran the job past its 15-minute
  // budget and every CI run on main was CANCELLED mid-E2E for four merges straight —
  // green locally, never green here, which is the worst shape a gate can have. Serial
  // execution was never the guarantee: every local run drives many workers against this
  // same single dev server, so parallelism against it is the proven case, not the risky
  // one. Two rather than many because the hosted runner has two cores and the dev server
  // compiles routes on demand; `retries: 1` below absorbs the contention that leaves.
  ...(process.env['CI'] ? { workers: 2 } : {}),
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
      testMatch: /(availability|billing|compose|csp|export|legal|grid-interactions|holidays|hotkeys|landing|leak|nav-feel|people|plan|prelaunch|view-as|edit-event|delete-event|fallbacks|settings|shell|visibility-sheet|views)\.spec\.ts/,
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'desktop',
      testMatch: /(availability|billing|compose|csp|export|legal|grid-interactions|holidays|hotkeys|landing|leak|nav-feel|people|plan|prelaunch|view-as|edit-event|delete-event|fallbacks|settings|shell|visibility-sheet|views)\.spec\.ts/,
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
      // Baselines are committed per platform (`-win32.png`, `-darwin.png`, `-linux.png`)
      // because font rasterisation genuinely differs between operating systems — the same
      // page is not the same pixels on Windows and macOS, and no tolerance setting closes
      // that gap honestly.
      //
      // So this project is SKIPPED on any platform that has no baselines committed yet.
      // The alternative was a suite that fails on a second machine for reasons that have
      // nothing to do with the code, which trains everyone to ignore it. Generate them on
      // a new platform with:
      //
      //   pnpm test:visual --update-snapshots
      //
      // and commit the result.
      //
      // AN EARLIER VERSION OF THIS COMMENT ENDED "CI pins one platform, so regressions are
      // still caught". That was false for the whole life of the file. Every committed
      // baseline was `-win32`; CI runs ubuntu and development happens on darwin, so the skip
      // fired on both and not one screenshot was ever compared — while the CI step carried
      // the name "E2E, accessibility and visual". The word describing the missing coverage
      // was sitting in the check name.
      //
      // BOTH SETS NOW EXIST: `-darwin` so the suite runs during development, and `-linux`
      // generated by the `visual-baselines` workflow and committed, so CI finally compares
      // something. Adding the darwin set alone was not enough and looked like it was — the
      // step went green on this machine while still comparing zero screenshots on ubuntu.
      // Regenerate the linux set by running that workflow and committing its artifact.
      ...(hasVisualBaselines() || isBootstrappingSnapshots() ? {} : { testIgnore: /.*/ }),
    },
  ],

  expect: {
    /*
     * FIFTEEN SECONDS, NOT PLAYWRIGHT'S FIVE, AND THE REASON IS THE TEST SERVER.
     *
     * This suite runs against `next dev`, which compiles a route on FIRST REQUEST, and eight
     * workers share one of them. A `toHaveURL` after a click into a cold route is therefore
     * waiting on a compile whose duration has no ceiling under load — and the default budget
     * was set for an assertion about a page that is already there.
     *
     * Measured rather than assumed: over seven full-suite runs, two different specs failed
     * this way on three of them, always with the mechanism working and only the wait expiring,
     * and always passing in isolation. That is the shape that reads as flaky infrastructure
     * and is really a budget set for an idle machine. There are 34 bare `toHaveURL` assertions
     * in `e2e/`, so fixing them one at a time is patching a class.
     *
     * The cost is that a genuinely failing assertion takes 15s rather than 5s to report, which
     * only matters when something is already broken. `retries: 1` on CI stays as the backstop
     * for contention this cannot absorb.
     */
    timeout: 15_000,
    toHaveScreenshot: {
      // Font rasterisation differs slightly between machines of the SAME platform (OS point
      // releases, GPU), so some tolerance is needed. 2% of a 1280x900 page is ~23,000 pixels
      // though, and that has a consequence worth stating rather than discovering:
      //
      //   THIS CATCHES LAYOUT, NOT SMALL COLOUR CHANGES. Repointing --brand-teal at red was
      //   measured at about 0.04% of the page — a few thin card borders — and passed. A
      //   background change failed all three specs immediately.
      //
      // Tightening the ratio does not fix that; no whole-page ratio can, because a small
      // element is a small number of pixels however strict you are. Colour is covered
      // separately and properly by CONTRAST_PAIRS in packages/ui/src/tokens.test.ts. Treat
      // these screenshots as a guard against things MOVING.
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
      /*
       * PLACEHOLDER SUPABASE VALUES, so a local run does not depend on an untracked file.
       *
       * `supabaseBrowser()` throws when either variable is absent, and /recover renders the
       * form its specs look for only if it does not throw. CI supplies these on the e2e step
       * for exactly that reason; locally they came from `apps/web/.env.local`, so a fresh
       * clone — or a machine where that file was moved aside to reproduce a CI build, which
       * CLAUDE.md tells you to do — failed four specs across three files for a reason that
       * has nothing to do with the change under test.
       *
       * `??`, not an override. Anyone who has real values keeps them; the suite never reaches
       * Supabase anyway, because every project runs against the committed fixture.
       */
      NEXT_PUBLIC_SUPABASE_URL:
        process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? 'https://placeholder.supabase.co',
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
        process.env['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'] ??
        'sb_publishable_local_placeholder_not_a_real_key',
    },
  },
})
