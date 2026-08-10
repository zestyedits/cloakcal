import { describe, expect, it } from 'vitest'
import { CloakStore, ServerDecryptionError, createCloakStore } from './store.js'

/**
 * The server half of the boundary. Runs in a node environment — no window, no document —
 * which is what a Server Component, route handler, server action or SSR render looks like.
 *
 * This test is the executable form of the rule: decryption is browser-only. The companion
 * static rule (server modules may not even IMPORT this package) lives in
 * server-boundary.leak.test.ts.
 */

describe('CloakStore refuses to exist on the server', () => {
  it('throws when constructed without a browser environment', () => {
    expect(() => new CloakStore()).toThrow(ServerDecryptionError)
  })

  it('throws through the factory too, so there is no side door', () => {
    expect(() => createCloakStore()).toThrow(ServerDecryptionError)
  })

  it('explains why, not just that', () => {
    // A developer hitting this in an RSC needs to know the rule, not just the failure.
    expect(() => createCloakStore()).toThrow(/browser-only/)
    expect(() => createCloakStore()).toThrow(/Server Component/)
  })

  it('confirms the environment really has no window', () => {
    expect(typeof globalThis.window).toBe('undefined')
  })
})
