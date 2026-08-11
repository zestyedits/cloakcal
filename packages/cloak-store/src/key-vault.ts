import { toSessionKey, type RootKey, type SessionKey } from '@cloakcal/crypto'

/**
 * Where the unlocked root key lives between page loads.
 *
 * A calendar that demands a password on every navigation is a calendar nobody uses, so the
 * key has to survive a reload. The question is only what form it survives in.
 *
 * IndexedDB stores a `CryptoKey` natively, and a key imported with `extractable = false`
 * comes back out still non-extractable. That is the entire reason this file exists: raw
 * bytes in IndexedDB — or worse, in localStorage — can be read by any script that reaches
 * the origin, and would then leave the device. A non-extractable key can be *used* by such
 * a script but never exported, so the exposure ends when the origin does. ADR 0002
 * specifies exactly this for the web surface.
 *
 * WHY NOT localStorage OR sessionStorage. Neither can hold a CryptoKey; both stringify.
 * Storing key material there is the failure mode this design exists to avoid.
 *
 * HONEST LIMIT. This does not defend against a compromised client. A script running in the
 * origin can decrypt whatever the user can decrypt, for as long as the key is stored. That
 * is inside the stated threat boundary (ADR 0002), and `forget()` is what a real sign-out
 * calls.
 */

const DB_NAME = 'cloakcal-keys'
const DB_VERSION = 1
const STORE = 'session-keys'

export class KeyVaultUnavailableError extends Error {
  constructor(reason: string) {
    super(`Key storage unavailable: ${reason}`)
    this.name = 'KeyVaultUnavailableError'
  }
}

const openDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    if (typeof globalThis.indexedDB === 'undefined') {
      reject(new KeyVaultUnavailableError('IndexedDB is not available in this context'))
      return
    }

    const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    // Private browsing modes reject the open outright. That is a legitimate state, not a
    // bug: the user simply unlocks again next visit.
    request.onerror = () =>
      reject(new KeyVaultUnavailableError(request.error?.message ?? 'open failed'))
  })

const withStore = async <T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> => {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const request = fn(tx.objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () =>
        reject(new KeyVaultUnavailableError(request.error?.message ?? 'request failed'))
    })
  } finally {
    db.close()
  }
}

/**
 * Keyed by user id so a second account signing in on the same browser cannot silently
 * inherit the first account's key and render its own events as decryption failures.
 */
export async function rememberSessionKey(userId: string, rootKey: RootKey): Promise<void> {
  const session = await toSessionKey(rootKey)
  // The CryptoKey is written, not its bytes — those are unreachable by this point.
  await withStore('readwrite', (store) => store.put(session.key, userId))
}

export async function recallSessionKey(userId: string): Promise<SessionKey | null> {
  const stored = await withStore<unknown>('readonly', (store) => store.get(userId))
  if (stored === undefined || stored === null) return null

  // Anything other than a genuinely non-extractable CryptoKey is treated as absent. A
  // tampered or downgraded record must never be promoted into a working key.
  if (!(stored instanceof CryptoKey) || stored.extractable || stored.algorithm.name !== 'HKDF') {
    await forgetSessionKey(userId)
    return null
  }

  return { key: stored }
}

export async function forgetSessionKey(userId: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(userId))
}

/** Sign-out, or a revoked device. Clears every account's key on this browser. */
export async function forgetAllSessionKeys(): Promise<void> {
  await withStore('readwrite', (store) => store.clear())
}
