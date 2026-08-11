/**
 * The browser-only decryption boundary.
 *
 * Every export here throws or refuses off-browser. No server module may import this
 * package — enforced statically by server-boundary.leak.test.ts.
 */

export * from './store.js'
export * from './key-vault.js'
