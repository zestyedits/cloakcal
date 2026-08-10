import type { NextConfig } from 'next'

const config: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source; Next must compile them.
  transpilePackages: ['@cloakcal/ui', '@cloakcal/domain', '@cloakcal/crypto', '@cloakcal/cloak-store'],
  typedRoutes: true,

  // Workspace packages import siblings as './recurrence.js' — the TypeScript/ESM
  // convention, where the specifier names the *emitted* file. These packages ship source,
  // so webpack must map that back to the .ts on disk. Without this every cross-file import
  // inside a workspace package fails to resolve.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    }
    return config
  },
}

export default config
