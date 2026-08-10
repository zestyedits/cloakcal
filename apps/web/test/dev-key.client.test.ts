/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The development unlock path.
 *
 * A dev key is exactly the kind of convenience that survives into production unnoticed, so
 * every gate on it is tested rather than assumed. NODE_ENV is inlined by Next at build
 * time, which is why the production check is the outermost one.
 */

afterEach(() => {
  // stubEnv rather than assigning process.env: NODE_ENV is typed read-only by @types/node,
  // and stubbing restores cleanly without defeating the type.
  vi.unstubAllEnvs()
  vi.resetModules()
})

const load = async () => import('../src/lib/dev-key.js')

describe('development unlock is opt-in', () => {
  it('refuses when the flag is absent', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_CLOAKCAL_DEV_UNLOCK', '')

    const { getDevRootKey, isDevUnlockEnabled } = await load()
    expect(isDevUnlockEnabled()).toBe(false)
    expect(() => getDevRootKey()).toThrow(/opt-in/)
  })

  it('refuses when the flag is anything other than "1"', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_CLOAKCAL_DEV_UNLOCK', 'true')

    const { getDevRootKey, isDevUnlockEnabled } = await load()
    expect(isDevUnlockEnabled()).toBe(false)
    expect(() => getDevRootKey()).toThrow()
  })

  it('grants a key when explicitly enabled outside production', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_CLOAKCAL_DEV_UNLOCK', '1')

    const { getDevRootKey, isDevUnlockEnabled } = await load()
    expect(isDevUnlockEnabled()).toBe(true)
    expect(getDevRootKey().bytes).toHaveLength(32)
  })
})

describe('production refuses the development key outright', () => {
  it('throws even when the flag is set', async () => {
    // The dangerous combination: someone sets the flag in a production environment.
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_CLOAKCAL_DEV_UNLOCK', '1')

    const { getDevRootKey, isDevUnlockEnabled } = await load()
    expect(isDevUnlockEnabled()).toBe(false)
    expect(() => getDevRootKey()).toThrow(/production build/)
  })

  it('says what to do instead, rather than just failing', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const { getDevRootKey } = await load()
    expect(() => getDevRootKey()).toThrow(/real unlock flow/)
  })
})

describe('the seed is a published constant, not a secret', () => {
  it('matches the fixture generator, so dev data decrypts', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_CLOAKCAL_DEV_UNLOCK', '1')

    const { __DEV_ROOT_KEY_SEED_FOR_TESTS } = await load()
    const expected = new Uint8Array(32).map((_, i) => (i * 31 + 7) % 256)
    expect(Array.from(__DEV_ROOT_KEY_SEED_FOR_TESTS)).toEqual(Array.from(expected))
  })
})
