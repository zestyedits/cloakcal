'use client'

import type { CloakStore } from '@cloakcal/cloak-store'

/**
 * Seal content for an RPC. The one place plaintext turns into something sendable.
 *
 * THE SUBJECT ID IS NOT INCIDENTAL. The AEAD binds each field's ciphertext to the event id
 * it was sealed against, and the per-field key is derived from that id too. Content sealed
 * for event A cannot be stored against event B — it will not decrypt, ever, and nothing at
 * write time will complain. So `eventId` here must be the id the row will actually be filed
 * under: the existing event when editing in place, and a freshly generated one when a scope
 * creates a new row (a detached occurrence, a split successor). That is the same defect
 * packages/db carried until migration 0010's commit, so it is worth stating twice.
 *
 * Hex rather than base64 because that is what `create_cloaked_event` and the other RPCs
 * decode with (`decode(..., 'hex')`).
 */

/** The shape the RPCs' `p_fields` jsonb expects. Snake case: it goes straight to Postgres. */
export interface RpcCloakedField {
  readonly field_name: string
  readonly ciphertext: string
  readonly nonce: string
  readonly alg: string
  readonly key_version: number
}

export async function sealFields(
  store: CloakStore,
  eventId: string,
  entries: ReadonlyArray<readonly [name: string, value: string]>,
): Promise<RpcCloakedField[]> {
  return Promise.all(
    entries.map(async ([fieldName, value]) => {
      const sealed = await store.seal('event', eventId, fieldName, value)
      return {
        field_name: fieldName,
        ciphertext: toHex(sealed.ciphertext),
        nonce: toHex(sealed.nonce),
        alg: sealed.alg,
        key_version: sealed.keyVersion,
      }
    }),
  )
}

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}
