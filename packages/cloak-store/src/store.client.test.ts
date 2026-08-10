/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cloakField, rootKeyFromSeedBytes } from '@cloakcal/crypto'
import {
  CloakSerializationError,
  createCloakStore,
  fieldKey,
  type CloakStore,
  type EncryptedFieldRecord,
} from './store.js'

/**
 * The client half of the boundary. The server half — that constructing this off-browser
 * throws — lives in store.server.test.ts, which runs in a node environment.
 */

const KEY = rootKeyFromSeedBytes(new Uint8Array(32).fill(5))
const OTHER_KEY = rootKeyFromSeedBytes(new Uint8Array(32).fill(6))
const EVENT_ID = '11111111-1111-4111-8111-111111111111'

let store: CloakStore

const record = async (fieldName: string, value: string): Promise<EncryptedFieldRecord> => {
  const sealed = await cloakField(KEY, { type: 'event', id: EVENT_ID }, fieldName, value)
  return {
    subjectType: 'event',
    subjectId: EVENT_ID,
    fieldName,
    ciphertext: sealed.ciphertext,
    nonce: sealed.nonce,
    alg: sealed.alg,
    keyVersion: sealed.keyVersion,
  }
}

beforeEach(() => {
  store = createCloakStore()
})

describe('decryption happens only after unlocking', () => {
  it('holds ciphertext as locked until a key arrives', async () => {
    await store.ingest([await record('title', 'Legal Call')])
    const key = fieldKey('event', EVENT_ID, 'title')

    expect(store.getSnapshot(key).status).toBe('locked')
    expect(store.isUnlocked).toBe(false)

    await store.unlock(KEY)
    expect(store.getSnapshot(key)).toEqual({ status: 'ready', value: 'Legal Call' })
  })

  it('decrypts records ingested after unlocking', async () => {
    await store.unlock(KEY)
    await store.ingest([await record('title', 'Legal Call')])
    expect(store.getSnapshot(fieldKey('event', EVENT_ID, 'title'))).toEqual({
      status: 'ready',
      value: 'Legal Call',
    })
  })

  it('reports an unknown key as missing rather than empty', async () => {
    await store.unlock(KEY)
    expect(store.getSnapshot(fieldKey('event', EVENT_ID, 'nope')).status).toBe('missing')
  })

  it('surfaces a decryption failure instead of rendering an empty string', async () => {
    await store.unlock(OTHER_KEY)
    await store.ingest([await record('title', 'Legal Call')])

    const snapshot = store.getSnapshot(fieldKey('event', EVENT_ID, 'title'))
    expect(snapshot.status).toBe('error')
    // An empty value would look like an untitled event, hiding tampering behind a blank.
    expect(snapshot).not.toHaveProperty('value')
  })
})

describe('locking drops every decrypted value', () => {
  it('clears values and notifies subscribers', async () => {
    await store.unlock(KEY)
    await store.ingest([await record('title', 'Legal Call')])
    const key = fieldKey('event', EVENT_ID, 'title')

    const listener = vi.fn()
    store.subscribe(key, listener)

    store.lock()
    expect(store.isUnlocked).toBe(false)
    expect(store.getSnapshot(key).status).toBe('missing')
    expect(listener).toHaveBeenCalled()
  })

  it('refuses to seal while locked', async () => {
    await expect(store.seal('event', EVENT_ID, 'title', 'x')).rejects.toThrow(/locked/)
  })
})

describe('the external store contract', () => {
  it('returns a reference-stable snapshot, so useSyncExternalStore will not loop', async () => {
    await store.unlock(KEY)
    await store.ingest([await record('title', 'Legal Call')])
    const key = fieldKey('event', EVENT_ID, 'title')

    expect(store.getSnapshot(key)).toBe(store.getSnapshot(key))
  })

  it('notifies only subscribers of the changed key', async () => {
    await store.unlock(KEY)
    const titleListener = vi.fn()
    const notesListener = vi.fn()
    store.subscribe(fieldKey('event', EVENT_ID, 'title'), titleListener)
    store.subscribe(fieldKey('event', EVENT_ID, 'notes'), notesListener)

    await store.ingest([await record('title', 'Legal Call')])

    expect(titleListener).toHaveBeenCalled()
    expect(notesListener).not.toHaveBeenCalled()
  })

  it('stops notifying after unsubscribe', async () => {
    await store.unlock(KEY)
    const listener = vi.fn()
    const unsubscribe = store.subscribe(fieldKey('event', EVENT_ID, 'title'), listener)
    unsubscribe()

    await store.ingest([await record('title', 'Legal Call')])
    expect(listener).not.toHaveBeenCalled()
  })

  it('uses a content-free key that is safe in a URL or React key', () => {
    const key = fieldKey('event', EVENT_ID, 'title')
    expect(key).toBe(`event:${EVENT_ID}:title`)
    expect(key).not.toContain('Legal')
  })
})

describe('plaintext cannot escape the store', () => {
  it('throws rather than serializing', async () => {
    await store.unlock(KEY)
    await store.ingest([await record('title', 'Legal Call')])

    expect(() => JSON.stringify(store)).toThrow(CloakSerializationError)
    expect(() => JSON.stringify({ store })).toThrow(CloakSerializationError)
  })

  it('exposes nothing through enumeration or spread', async () => {
    await store.unlock(KEY)
    await store.ingest([await record('title', 'Legal Call')])

    // Spreading the store must yield literally nothing — no values, and no function
    // fields either, so the guarantee is checkable rather than "only harmless keys".
    expect(Object.keys(store)).toEqual([])
    expect({ ...store }).toEqual({})
    expect(JSON.stringify(Object.entries({ ...store }))).not.toContain('Legal Call')
    expect(store.subscribe).toBeTypeOf('function')
  })

  it('structured-clones to an empty object, so IndexedDB and postMessage carry nothing', async () => {
    await store.unlock(KEY)
    await store.ingest([await record('title', 'Legal Call')])

    // structuredClone does NOT throw on a class instance — it copies own ENUMERABLE
    // properties and drops the prototype. That is precisely why the values live in
    // `#private` fields and the two function fields were made non-enumerable: the clone
    // has nothing to copy. This is the path that matters for IndexedDB persistence,
    // postMessage to a worker, and React DevTools snapshots.
    const clone = structuredClone(store)
    expect(clone).toEqual({})
    expect(JSON.stringify(clone)).not.toContain('Legal Call')
  })

  it('leaks nothing through a naive error report of the store', async () => {
    await store.unlock(KEY)
    await store.ingest([await record('title', 'Legal Call')])

    // The realistic accident: an error handler stringifies context.
    let captured: string
    try {
      captured = JSON.stringify({ context: store })
    } catch (error) {
      captured = String(error)
    }
    expect(captured).not.toContain('Legal Call')
  })

  it('keeps plaintext out of the ciphertext it holds', async () => {
    await store.unlock(KEY)
    const rec = await record('title', 'Legal Call')
    await store.ingest([rec])
    expect(Buffer.from(rec.ciphertext).toString('utf8')).not.toContain('Legal Call')
  })
})

describe('writes re-encrypt before leaving the client', () => {
  it('seals plaintext into a payload the server can store', async () => {
    await store.unlock(KEY)
    const sealed = await store.seal('event', EVENT_ID, 'title', 'Legal Call')

    expect(sealed.alg).toBe('aes-256-gcm-v1')
    expect(sealed.nonce).toHaveLength(12)
    expect(Buffer.from(sealed.ciphertext).toString('utf8')).not.toContain('Legal Call')
    expect(sealed.ciphertext.length).toBeGreaterThanOrEqual(16)
  })

  it('produces a payload that round-trips through ingest', async () => {
    await store.unlock(KEY)
    const sealed = await store.seal('event', EVENT_ID, 'notes', 'Sensitive')

    const fresh = createCloakStore()
    await fresh.unlock(KEY)
    await fresh.ingest([
      {
        subjectType: 'event',
        subjectId: EVENT_ID,
        fieldName: 'notes',
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce,
        alg: sealed.alg,
        keyVersion: sealed.keyVersion,
      },
    ])

    expect(fresh.getSnapshot(fieldKey('event', EVENT_ID, 'notes'))).toEqual({
      status: 'ready',
      value: 'Sensitive',
    })
  })
})
