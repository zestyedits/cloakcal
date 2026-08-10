'use client'

import { rootKeyFromSeedBytes, type RootKey } from '@cloakcal/crypto'

/**
 * Development-only root key.
 *
 * Real key derivation — password KEK, recovery phrase, device pairing — is M3 (ADR 0002).
 * Until then the shell needs *some* key to decrypt the fixture, and a dev unlock path is
 * exactly the kind of thing that quietly survives into production if it is not gated and
 * tested from day one.
 *
 * Three gates, all of which must pass:
 *   1. NODE_ENV must not be production. Next inlines this at build time, so a production
 *      bundle throws even if someone sets the env var at runtime.
 *   2. It must be explicitly enabled. Absence is refusal, not a default.
 *   3. It must be running in a browser, like everything else that touches a key.
 *
 * The seed matches tools/generate-fixture.ts. It is a published constant with no secrecy
 * value whatsoever, which is the point: nothing encrypted with it is protected, and
 * treating it as though it were would be worse than saying so.
 */

const DEV_ROOT_KEY_SEED = new Uint8Array(32).map((_, i) => (i * 31 + 7) % 256)

export class DevKeyRefusedError extends Error {
  constructor(reason: string) {
    super(`Development key refused: ${reason}`)
    this.name = 'DevKeyRefusedError'
  }
}

export function isDevUnlockEnabled(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.NEXT_PUBLIC_CLOAKCAL_DEV_UNLOCK === '1'
  )
}

export function getDevRootKey(): RootKey {
  if (process.env.NODE_ENV === 'production') {
    throw new DevKeyRefusedError(
      'this is a production build. Development keys never ship; use the real unlock flow.',
    )
  }
  if (process.env.NEXT_PUBLIC_CLOAKCAL_DEV_UNLOCK !== '1') {
    throw new DevKeyRefusedError(
      'NEXT_PUBLIC_CLOAKCAL_DEV_UNLOCK is not set to "1". Development unlock is opt-in.',
    )
  }
  if (typeof window === 'undefined') {
    throw new DevKeyRefusedError('key material is browser-only.')
  }
  return rootKeyFromSeedBytes(DEV_ROOT_KEY_SEED)
}

/** Exported for the guard tests, which must assert against the real seed. */
export const __DEV_ROOT_KEY_SEED_FOR_TESTS = DEV_ROOT_KEY_SEED
