'use client'

// The import below is TYPE-ONLY and erases at build time, so nothing from cloak-store
// actually ships here. The directive is still required, and correctly so: the server
// boundary test is textual and absolute by design (CLAUDE.md rule 2). A scanner that tried
// to reason about which imports erase would be a scanner that can be argued with, and the
// whole point of that gate is that it cannot be.
import type { FieldSnapshot } from '@cloakcal/cloak-store'

/**
 * Decide which content fields to re-seal and which to remove.
 *
 * Pure and separate from the component, because this is the part of editing that can
 * silently destroy data — it deserves tests that do not need a DOM.
 *
 * THE DANGEROUS CASE IS `error`. A field whose ciphertext will not decrypt on this device
 * has no readable value, so the form shows it empty. Treating that empty box as the user's
 * intent would replace real content with nothing, permanently, and it would look like the
 * user did it. So an `error` field the user never touched is in NEITHER list: not sealed,
 * not cleared, left exactly as it is on the server. Type into it and it becomes an ordinary
 * edit again, because now there is an intent to act on.
 *
 * EMPTY MEANS REMOVE, NOT "SEAL AN EMPTY STRING". An empty encrypted value decrypts to
 * nothing and renders as an untitled event; absence is the honest representation of "I
 * deleted my notes", and it is what the read path already treats as "no such field".
 *
 * UNCHANGED FIELDS ARE NOT SENT. Editing in place keeps the same event id, so the AAD is
 * unchanged and existing rows stay valid. Re-sealing them would churn nonces for nothing and
 * would clobber a concurrent edit to a field this user never looked at.
 */

export interface EditableField {
  readonly name: string
  /** What the store knows about the stored value. */
  readonly snapshot: FieldSnapshot
  /** What is in the form right now. */
  readonly value: string
  /** Whether the user has actually edited this input. */
  readonly touched: boolean
}

export interface FieldChanges {
  /** [fieldName, plaintext] pairs to seal against the event id. */
  readonly seal: ReadonlyArray<readonly [string, string]>
  /** Field names whose rows should be deleted. */
  readonly clear: readonly string[]
  /**
   * Fields skipped because they could not be decrypted and were not edited. Surfaced so the
   * UI can say so rather than quietly doing less than the user expects.
   */
  readonly skippedUnreadable: readonly string[]
}

export function planFieldChanges(fields: readonly EditableField[]): FieldChanges {
  const seal: Array<readonly [string, string]> = []
  const clear: string[] = []
  const skippedUnreadable: string[] = []

  for (const field of fields) {
    const next = field.value.trim()

    if (field.snapshot.status === 'error' && !field.touched) {
      skippedUnreadable.push(field.name)
      continue
    }

    // `missing` and `error` both mean "no value we can compare against". For `missing` that
    // is genuinely the empty string — the owner receives every field that exists, so a field
    // absent from the store is a field absent from the database. For a touched `error` field
    // there is no prior value, so anything the user typed counts as a change.
    const initial = field.snapshot.status === 'ready' ? field.snapshot.value : ''
    const unknownInitial = field.snapshot.status === 'error'

    if (!unknownInitial && next === initial) continue

    if (next === '') {
      // Nothing to remove if there was nothing there.
      if (!unknownInitial && initial === '') continue
      clear.push(field.name)
    } else {
      seal.push([field.name, next])
    }
  }

  return { seal, clear, skippedUnreadable }
}

/** Nothing to send. Used to keep Save disabled, so a no-op cannot bump the version. */
export function isNoop(changes: FieldChanges, timingChanged: boolean): boolean {
  return !timingChanged && changes.seal.length === 0 && changes.clear.length === 0
}
