import { cloakField, uncloakField, type CloakedPayload, type KeyMaterial } from '@cloakcal/crypto'

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

/**
 * Mirrors the `public.cloak_subject` enum. `contact` and `contact_group` were added in
 * migration 0015 so contact names and group labels could be Cloaked (ADR 0004) — the AAD and
 * the per-field key salt both include the subject type, so a value missing here cannot be
 * sealed or opened at all.
 *
 * Adding a value to the database enum without adding it here is a silent half-migration: the
 * row stores fine and nothing can ever read it back.
 */
export type CloakSubjectType = 'event' | 'calendar' | 'workspace' | 'contact' | 'contact_group'

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

/**
 * Do two records carry the same sealed bytes?
 *
 * Nonce first, because it is the cheap discriminator: AES-GCM draws a fresh random nonce on
 * every seal, so re-encrypting the same plaintext still produces a different record. Two
 * records agreeing on nonce AND ciphertext are the same seal, not merely the same content —
 * and the store cannot know the plaintext matches without decrypting, which is the work
 * this comparison exists to avoid.
 *
 * `keyVersion` is included because a rewrapped field can decrypt to the same string under a
 * new key: the cached VALUE would still be right, but the cached RECORD would not be.
 */
const sameCiphertext = (a: EncryptedFieldRecord, b: EncryptedFieldRecord): boolean =>
  a.keyVersion === b.keyVersion &&
  a.alg === b.alg &&
  sameBytes(a.nonce, b.nonce) &&
  sameBytes(a.ciphertext, b.ciphertext)

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

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
  #rootKey: KeyMaterial | null = null

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
  async unlock(rootKey: KeyMaterial): Promise<void> {
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

  /**
   * Accept ciphertext from the server and decrypt it, if unlocked.
   *
   * INGEST IS AUTHORITATIVE, and that took a fix. `#decryptAll` deliberately skips a field
   * that is already `ready`, so unlocking does not redo work — but that skip also meant the
   * store showed the FIRST ciphertext it ever saw for a key and silently ignored every later
   * one. Re-ingesting an edited event left the old title on screen.
   *
   * Nothing caught it because CloakProvider throws the whole store away and builds a new one
   * whenever the page object changes, so nothing ever re-ingested into a live store. That
   * makes correctness rest on object identity in a dependency array: memoize `page`, adopt
   * useOptimistic, or move to a partial refresh, and stale content returns with no test to
   * notice.
   *
   * So invalidation belongs here rather than in the skip. A record whose bytes differ from
   * the cached one drops the decrypted value first and `#decryptAll` re-derives it;
   * identical bytes are still skipped, so the optimisation survives.
   */
  async ingest(records: readonly EncryptedFieldRecord[]): Promise<void> {
    for (const record of records) {
      const key = fieldKey(record.subjectType, record.subjectId, record.fieldName)
      const previous = this.#ciphertext.get(key)
      if (previous !== undefined && !sameCiphertext(previous, record)) {
        this.#values.delete(key)
      }
      this.#ciphertext.set(key, record)
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
