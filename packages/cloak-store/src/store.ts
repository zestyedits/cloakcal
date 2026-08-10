import { cloakField, uncloakField, type CloakedPayload, type RootKey } from '@cloakcal/crypto'

/**
 * CloakStore — the one place decrypted Tier B content exists.
 *
 * BROWSER ONLY, BY CONSTRUCTION. Constructing this on a server throws. Decryption must
 * never happen in a Server Component, route handler, server action, RSC loader or SSR
 * prefetch: server responses carry Tier A metadata and ciphertext, nothing else.
 *
 * NON-SERIALIZABLE, BY CONSTRUCTION. Values live in `#private` fields, so they are
 * invisible to `Object.keys`, spread, and `JSON.stringify`. `toJSON` throws rather than
 * returning `{}`, so an accidental serialization is a loud failure instead of a silent
 * one. `structuredClone` already refuses class instances, which blocks the postMessage and
 * IndexedDB paths.
 *
 * Plaintext does legitimately reach the render path — that is what a calendar is — and
 * that is inside the stated client-compromise boundary (ADR 0002). What must never happen
 * is plaintext crossing back OUT: into an RSC/Flight payload, server-rendered props, query
 * persistence, localStorage, logs, analytics, error reports, snapshots, URL state, a
 * server action argument, or Next's data cache.
 *
 * Writes go the other way through `seal()`: a component hands over plaintext, receives
 * ciphertext, and only ciphertext is sent to the server.
 */

export type CloakSubjectType = 'event' | 'calendar' | 'workspace'

/** Opaque key. Stable and content-free — safe to use as a React key or in a URL. */
export type FieldKey = string & { readonly __brand: 'CloakFieldKey' }

export function fieldKey(
  subjectType: CloakSubjectType,
  subjectId: string,
  fieldName: string,
): FieldKey {
  return `${subjectType}:${subjectId}:${fieldName}` as FieldKey
}

export interface EncryptedFieldRecord {
  readonly subjectType: CloakSubjectType
  readonly subjectId: string
  readonly fieldName: string
  readonly ciphertext: Uint8Array
  readonly nonce: Uint8Array
  readonly alg: string
  readonly keyVersion: number
}

export type FieldSnapshot =
  /** No record for this key has been ingested. */
  | { readonly status: 'missing' }
  /** Ciphertext is held but the store has no key yet. */
  | { readonly status: 'locked' }
  | { readonly status: 'ready'; readonly value: string }
  /** Decryption failed. Surfaced, never rendered as an empty string. */
  | { readonly status: 'error'; readonly reason: string }

const MISSING: FieldSnapshot = Object.freeze({ status: 'missing' })
const LOCKED: FieldSnapshot = Object.freeze({ status: 'locked' })

export class ServerDecryptionError extends Error {
  constructor() {
    super(
      'CloakStore cannot be used on the server. Decryption is browser-only: a Server ' +
        'Component, route handler, server action or SSR path must never hold plaintext.',
    )
    this.name = 'ServerDecryptionError'
  }
}

export class CloakSerializationError extends Error {
  constructor() {
    super(
      'CloakStore must never be serialized. Decrypted content may not cross an RSC/Flight ' +
        'boundary, or reach storage, logs, analytics or error reports.',
    )
    this.name = 'CloakSerializationError'
  }
}

const isBrowser = (): boolean =>
  typeof globalThis.window !== 'undefined' && typeof globalThis.document !== 'undefined'

export class CloakStore {
  // `#private` rather than `private`: TypeScript's `private` is erased at runtime and the
  // field stays fully enumerable. `#` fields are genuinely inaccessible, so no amount of
  // spreading, Object.entries or structured logging can reach the plaintext.
  readonly #values = new Map<FieldKey, FieldSnapshot>()
  readonly #ciphertext = new Map<FieldKey, EncryptedFieldRecord>()
  readonly #listeners = new Map<FieldKey, Set<() => void>>()
  #rootKey: RootKey | null = null

  constructor() {
    if (!isBrowser()) throw new ServerDecryptionError()

    // `getSnapshot` and `subscribe` are arrow-function fields so React can call them
    // detached, but class fields are enumerable own properties — which means a spread or
    // Object.keys would show them. They carry no content, yet leaving the enumerable
    // surface non-empty weakens the guarantee we want to assert: spreading this object
    // must yield {}. Hiding them makes that literally true and easy to test.
    for (const name of ['getSnapshot', 'subscribe'] as const) {
      Object.defineProperty(this, name, { enumerable: false })
    }
  }

  /** Provide the key and decrypt everything already ingested. */
  async unlock(rootKey: RootKey): Promise<void> {
    this.#rootKey = rootKey
    await this.#decryptAll()
  }

  /**
   * Drop the key and every decrypted value.
   *
   * Honest limitation: JavaScript strings are immutable, so this releases references
   * rather than wiping memory. When the garbage collector reclaims them is outside our
   * control. Overwriting would require the values never to have been strings, which is
   * incompatible with rendering them. Stated plainly in ADR 0002 rather than implied away.
   */
  lock(): void {
    this.#rootKey = null
    const keys = [...this.#values.keys()]
    this.#values.clear()
    for (const key of keys) this.#notify(key)
  }

  get isUnlocked(): boolean {
    return this.#rootKey !== null
  }

  /** Accept ciphertext from the server and decrypt it, if unlocked. */
  async ingest(records: readonly EncryptedFieldRecord[]): Promise<void> {
    for (const record of records) {
      this.#ciphertext.set(fieldKey(record.subjectType, record.subjectId, record.fieldName), record)
    }
    if (this.#rootKey !== null) {
      await this.#decryptAll()
    } else {
      for (const record of records) {
        const key = fieldKey(record.subjectType, record.subjectId, record.fieldName)
        this.#values.set(key, LOCKED)
        this.#notify(key)
      }
    }
  }

  /**
   * Encrypt plaintext for transmission. The ONLY way content should leave a component
   * headed for a server action or API mutation.
   */
  async seal(
    subjectType: CloakSubjectType,
    subjectId: string,
    fieldName: string,
    plaintext: string,
  ): Promise<CloakedPayload> {
    if (this.#rootKey === null) {
      throw new Error('CloakStore is locked; cannot seal content')
    }
    return cloakField(this.#rootKey, { type: subjectType, id: subjectId }, fieldName, plaintext)
  }

  /** useSyncExternalStore contract. The returned object is reference-stable until it changes. */
  getSnapshot = (key: FieldKey): FieldSnapshot => this.#values.get(key) ?? MISSING

  subscribe = (key: FieldKey, listener: () => void): (() => void) => {
    let set = this.#listeners.get(key)
    if (set === undefined) {
      set = new Set()
      this.#listeners.set(key, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.#listeners.delete(key)
    }
  }

  async #decryptAll(): Promise<void> {
    const rootKey = this.#rootKey
    if (rootKey === null) return

    for (const [key, record] of this.#ciphertext) {
      const existing = this.#values.get(key)
      if (existing?.status === 'ready') continue

      try {
        const value = await uncloakField(
          rootKey,
          { type: record.subjectType, id: record.subjectId },
          record.fieldName,
          {
            ciphertext: new Uint8Array(record.ciphertext),
            nonce: new Uint8Array(record.nonce),
            alg: record.alg as CloakedPayload['alg'],
            keyVersion: record.keyVersion,
          },
        )
        this.#values.set(key, Object.freeze({ status: 'ready', value }))
      } catch (error) {
        // Surface the failure. Rendering an empty string would hide a tampered or
        // wrong-key record behind what looks like an empty field.
        this.#values.set(
          key,
          Object.freeze({
            status: 'error',
            reason: error instanceof Error ? error.message : 'Decryption failed',
          }),
        )
      }
      this.#notify(key)
    }
  }

  #notify(key: FieldKey): void {
    for (const listener of this.#listeners.get(key) ?? []) listener()
  }

  /** Loud failure instead of a silent `{}`. */
  toJSON(): never {
    throw new CloakSerializationError()
  }
}

export function createCloakStore(): CloakStore {
  return new CloakStore()
}
