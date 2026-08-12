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

/** 24 words, 256 bits plus checksum. Exported so the UI does not hardcode the count. */
export const RECOVERY_WORD_COUNT = 24

/**
 * Split whatever a person pasted into exactly 24 slots.
 *
 * People paste from a screenshot, a PDF, a password manager, or a numbered list. Line breaks,
 * double spaces, non-breaking spaces and stray capitals are all the RIGHT phrase entered by a
 * real person, so all of them must land in the right boxes. Short input is padded and long
 * input keeps its overflow visible rather than being silently truncated — a phrase quietly cut
 * to 24 words would fail the checksum with no clue why.
 */
export function splitRecoveryPhrase(input: string): string[] {
  const trimmed = input.normalize('NFKD').trim()
  if (trimmed === '') return Array.from({ length: RECOVERY_WORD_COUNT }, () => '')

  const words = trimmed
    .toLowerCase()
    // Numbered lists paste as "1. abandon 2. ability". Strip the ordinals rather than
    // treating them as words, because that is a real thing our own kit file produces.
    .replace(/\b\d{1,2}[.)]\s*/gu, '')
    .split(/\s+/u)

  return words.length >= RECOVERY_WORD_COUNT
    ? words
    : [...words, ...Array.from({ length: RECOVERY_WORD_COUNT - words.length }, () => '')]
}

/**
 * Is this a word from the BIP-39 English list?
 *
 * SAFE TO SHOW, and worth being explicit about why: the wordlist is a public constant, so
 * telling someone "zzzz is not a BIP-39 word" reveals nothing about THEIR phrase. What must
 * never be offered is validation against the real phrase — "word 7 is wrong" would turn the
 * form into an oracle that recovers the phrase one word at a time.
 *
 * So the UI may flag a word that is not in the list, and may report that the whole phrase
 * fails its checksum, and nothing finer than that.
 */
export function isRecoveryWord(word: string): boolean {
  return wordlist.includes(word.normalize('NFKD').trim().toLowerCase())
}

/**
 * Autocomplete candidates for a partly-typed word.
 *
 * BIP-39's English list is mutual-prefix-unique at four letters, so four characters always
 * narrows to one. Fewer than two is not worth suggesting — the list is 2048 words and a
 * single letter matches over a hundred.
 */
export function completeRecoveryWord(prefix: string, limit = 8): string[] {
  const p = prefix.normalize('NFKD').trim().toLowerCase()
  if (p.length < 2) return []
  const out: string[] = []
  for (const word of wordlist) {
    if (word.startsWith(p)) {
      out.push(word)
      if (out.length === limit) break
    }
  }
  return out
}
