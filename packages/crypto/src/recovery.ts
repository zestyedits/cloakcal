import { generateMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { encodeCanonical, subtle } from './cloak.js'

/**
 * The recovery phrase — the wrap that exists because passwords get forgotten.
 *
 * 24 words from the BIP-39 English wordlist: 256 bits of entropy plus an 8-bit checksum.
 * The checksum is the reason for using BIP-39 rather than rolling a wordlist. A user
 * transcribing 24 words by hand will occasionally write one down wrong, and without a
 * checksum the only signal is "unwrap failed", which is indistinguishable from "wrong
 * phrase entirely". With one, a mistyped phrase is rejected as malformed before any
 * cryptography runs, and the UI can say so.
 *
 * The list is also mutual-prefix-unique in its first four letters, so autocorrect damage
 * and handwriting ambiguity are recoverable. That is worth more here than novelty.
 *
 * WHY NOT mnemonicToSeed. BIP-39's seed derivation is 2048 rounds of PBKDF2 aimed at
 * hardening a wallet passphrase. Our phrase already carries a full 256 bits of CSPRNG
 * entropy — there is nothing for a work factor to protect, because there is no guessable
 * human input in it. HKDF over the raw entropy is the honest operation: domain separation,
 * not theatre.
 */

export class InvalidRecoveryPhraseError extends Error {
  constructor(reason: string) {
    super(`Recovery phrase rejected: ${reason}`)
    this.name = 'InvalidRecoveryPhraseError'
  }
}

/** 24 words. Shown once, at setup, and confirmed before the account is usable (D7). */
export function generateRecoveryPhrase(): string {
  return generateMnemonic(wordlist, 256)
}

/**
 * People paste phrases with line breaks, double spaces, capitals from a screenshot OCR, and
 * non-breaking spaces from a PDF. All of those are the right phrase typed by a real person,
 * so all of them must work.
 */
export function normalizeRecoveryPhrase(input: string): string {
  return input.normalize('NFKD').trim().toLowerCase().split(/\s+/u).join(' ')
}

export function isValidRecoveryPhrase(input: string): boolean {
  return validateMnemonic(normalizeRecoveryPhrase(input), wordlist)
}

/**
 * Derive the AES-GCM key this phrase wraps the root key with.
 *
 * Non-extractable, like every other wrapping key: the phrase itself is the only thing the
 * user is ever asked to hold, and nothing derived from it should be readable back out of
 * JavaScript.
 */
export async function deriveRecoveryWrapKey(phrase: string): Promise<CryptoKey> {
  const normalized = normalizeRecoveryPhrase(phrase)

  const words = normalized.split(' ')
  if (words.length !== 24) {
    throw new InvalidRecoveryPhraseError(`expected 24 words, received ${words.length}`)
  }
  if (!validateMnemonic(normalized, wordlist)) {
    // BIP-39's checksum caught it. Almost always one mistyped or transposed word.
    throw new InvalidRecoveryPhraseError('the checksum does not match, so a word is wrong')
  }

  const entropy = mnemonicToEntropy(normalized, wordlist)
  const s = subtle()
  const material = await s.importKey('raw', entropy as Uint8Array<ArrayBuffer>, 'HKDF', false, [
    'deriveKey',
  ])

  return s.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encodeCanonical('cloakcal.wrap-salt.v1', []),
      info: encodeCanonical('cloakcal.hkdf.v1', ['cloakcal.recovery.v1']),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}
