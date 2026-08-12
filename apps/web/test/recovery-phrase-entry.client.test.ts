import { describe, expect, it } from 'vitest'
import {
  RECOVERY_WORD_COUNT,
  completeRecoveryWord,
  isRecoveryWord,
  isValidRecoveryPhrase,
  splitRecoveryPhrase,
} from '@cloakcal/crypto'

/**
 * Phrase entry, and the line between helpful and an oracle.
 *
 * The form is allowed to say "that is not a BIP-39 word" and "these 24 words do not check out
 * together". It must never say anything about the phrase ON FILE. The distinction is not
 * cosmetic: 24 independent yes/no questions against the real phrase would recover it in
 * minutes, where guessing it whole is impossible.
 *
 * Everything asserted here is a property of the input the user typed, or of a public constant.
 */

const VALID =
  'legal winner thank year wave sausage worth useful legal winner thank year ' +
  'wave sausage worth useful legal winner thank year wave sausage worth title'

describe('splitting whatever was pasted', () => {
  it('always yields 24 slots from empty input', () => {
    expect(splitRecoveryPhrase('')).toHaveLength(RECOVERY_WORD_COUNT)
    expect(splitRecoveryPhrase('   ')).toHaveLength(RECOVERY_WORD_COUNT)
  })

  it('absorbs the ways a real phrase actually arrives', () => {
    // Screenshot OCR gives capitals, a PDF gives non-breaking spaces, a password manager
    // gives line breaks. All of these are the right phrase typed by a real person.
    const messy = ' Legal\nWINNER thank\t year  wave '
    expect(splitRecoveryPhrase(messy).slice(0, 5)).toEqual([
      'legal',
      'winner',
      'thank',
      'year',
      'wave',
    ])
  })

  it('strips the numbering our own recovery kit writes', () => {
    // The kit file is numbered so it is readable on paper. If pasting it back produced
    // "1." as word one, the feature would be self-defeating.
    const fromKit = ' 1. legal\n 2. winner\n 3. thank\n10. year\n'
    expect(splitRecoveryPhrase(fromKit).slice(0, 4)).toEqual(['legal', 'winner', 'thank', 'year'])
  })

  it('keeps overflow visible rather than truncating to 24', () => {
    // A phrase quietly cut to length would fail the checksum with no clue why.
    const twentyFive = Array.from({ length: 25 }, () => 'legal').join(' ')
    expect(splitRecoveryPhrase(twentyFive)).toHaveLength(25)
  })

  it('round-trips a real phrase', () => {
    expect(splitRecoveryPhrase(VALID).join(' ')).toBe(VALID)
    expect(isValidRecoveryPhrase(VALID)).toBe(true)
  })
})

describe('what the form may tell you', () => {
  it('knows a word from the public list', () => {
    expect(isRecoveryWord('abandon')).toBe(true)
    expect(isRecoveryWord('ABANDON')).toBe(true)
    expect(isRecoveryWord(' abandon ')).toBe(true)
  })

  it('rejects a word that is not in it', () => {
    // Safe to surface: the wordlist is a public constant, so this says nothing about the
    // phrase on file. It is usually just a half-typed word.
    expect(isRecoveryWord('zzzz')).toBe(false)
    expect(isRecoveryWord('')).toBe(false)
  })

  it('catches a phrase of real words that still does not check out', () => {
    // BIP-39's checksum. This is a property of what was typed, not of what is stored, so
    // reporting it discloses nothing — and it is the difference between "one word is wrong"
    // and an unexplained decryption failure.
    const swapped = VALID.split(' ')
    const [a, b] = [swapped[0]!, swapped[1]!]
    swapped[0] = b
    swapped[1] = a
    expect(swapped.every(isRecoveryWord)).toBe(true)
    expect(isValidRecoveryPhrase(swapped.join(' '))).toBe(false)
  })
})

describe('autocomplete', () => {
  it('says nothing for a single letter', () => {
    // 2048 words; one letter matches over a hundred. Suggesting there is noise, not help.
    expect(completeRecoveryWord('a')).toEqual([])
    expect(completeRecoveryWord('')).toEqual([])
  })

  it('narrows from two letters', () => {
    const hits = completeRecoveryWord('ab')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((word) => word.startsWith('ab'))).toBe(true)
  })

  it('resolves to exactly one at four letters, which is why BIP-39 chose this list', () => {
    // The English list is mutual-prefix-unique at four characters. That property is what
    // makes handwriting ambiguity and autocorrect damage recoverable.
    expect(completeRecoveryWord('aban')).toEqual(['abandon'])
    expect(completeRecoveryWord('zoo_')).toEqual([])
  })

  it('suggests only real words, so it cannot leak a phrase', () => {
    expect(completeRecoveryWord('leg').every(isRecoveryWord)).toBe(true)
  })
})
