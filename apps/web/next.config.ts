import type { NextConfig } from 'next'

const config: NextConfig = {
  reactStrictMode: true,

  // Production builds go to their own directory. `next dev` writes to .next, and it would
  // otherwise overwrite the prerendered HTML and RSC payloads that the build-output leak
  // suite inspects — making a privacy gate fail for reasons that have nothing to do with
  // privacy, purely because E2E ran first.
  distDir: process.env['NEXT_DIST_DIR'] ?? '.next',
  // Workspace packages ship TypeScript source; Next must compile them.
  transpilePackages: ['@cloakcal/ui', '@cloakcal/domain', '@cloakcal/crypto', '@cloakcal/cloak-store', '@cloakcal/policy'],
  typedRoutes: true,

  // The dev-mode indicator badge renders on top of the page and would be baked into every
  // visual baseline, so a screenshot diff would fire on a Next version bump rather than on
  // a real layout change.
  devIndicators: false,

  // Workspace packages import siblings as './recurrence.js' — the TypeScript/ESM
  // convention, where the specifier names the *emitted* file. These packages ship source,
  // so webpack must map that back to the .ts on disk. Without this every cross-file import
  // inside a workspace package fails to resolve.
  //
  // THIS BLOCK ONLY RUNS UNDER WEBPACK, AND NOTHING IN THE REPO ENFORCES THAT.
  //
  // An earlier version of this comment claimed `next build` passes `--webpack`. It does not,
  // and it cannot: there is no such flag on `next build` in 15.5 (`next build --help` lists
  // only `--turbo`/`--turbopack`). Webpack is simply still the DEFAULT, and Turbopack is
  // opt-in. So the real rule is the negative one:
  //
  //   *** DO NOT ADD `--turbopack` TO THE BUILD OR DEV SCRIPT. ***
  //
  // Turbopack ignores this hook, so every cross-file import inside a workspace package would
  // fail to resolve. It also panics compiling this app's middleware ("missing
  // incrementalCacheHandler in template"), so the choice is not hypothetical.
  //
  // This becomes load-bearing at the Next 16 upgrade, where Turbopack is the default and the
  // opt-out has to be explicit. That upgrade must not be a version bump alone — check that
  // `.js` → `.ts` resolution still happens before merging it.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    }
    return config
  },
}

export default config
