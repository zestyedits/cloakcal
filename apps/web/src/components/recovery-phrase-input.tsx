'use client'

import { useId, useMemo } from 'react'
import {
  RECOVERY_WORD_COUNT,
  completeRecoveryWord,
  isRecoveryWord,
  isValidRecoveryPhrase,
  splitRecoveryPhrase,
} from '@cloakcal/crypto'
import styles from './recovery-phrase-input.module.css'

/**
 * Twenty-four boxes, not one textarea.
 *
 * The textarea version was defensible and quietly awful. Typing 24 words with no structure
 * gives you no idea where you are, no way to see that word 19 is missing, and one shot at
 * getting all of it right. Recovery is used exactly once, under stress, often from a photo of
 * a piece of paper — the moment to make the interface do some work.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS ALLOWED TO TELL YOU, AND WHAT IT MUST NOT
 * ---------------------------------------------------------------------------
 *
 * It flags a word that is not in the BIP-39 list, and it reports that the phrase as a whole
 * fails its checksum. Both are safe: the wordlist is a public constant, so "zzzz is not a
 * word" says nothing about YOUR phrase, and the checksum is a property of the phrase you
 * typed rather than of the one on file.
 *
 * It must never validate against the real phrase. "Word 7 is wrong" would turn this form into
 * an oracle that recovers the whole thing one word at a time — 24 cheap questions instead of
 * one impossible guess. Nothing here has access to the stored phrase, and nothing should.
 *
 * ---------------------------------------------------------------------------
 * PASTE FILLS EVERYTHING
 * ---------------------------------------------------------------------------
 *
 * Pasting into any box distributes the whole phrase across all 24, because that is what
 * someone with the words in a password manager will do. `splitRecoveryPhrase` absorbs line
 * breaks, double spaces, non-breaking spaces from a PDF, and the numbered-list format our own
 * recovery kit file writes.
 */

export function RecoveryPhraseInput({
  value,
  onChange,
  disabled = false,
  label = 'Recovery phrase',
}: {
  /** Space-joined phrase. Kept as one string so callers stay unchanged. */
  value: string
  onChange: (next: string) => void
  disabled?: boolean
  label?: string
}) {
  const id = useId()
  const words = useMemo(() => splitRecoveryPhrase(value), [value])

  const setWord = (index: number, word: string) => {
    const next = [...words]
    next[index] = word.trim().toLowerCase()
    onChange(next.join(' ').trimEnd())
  }

  const paste = (event: React.ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text')
    // A single word pasted into one box is just typing; only spread when it is a phrase.
    if (!/\s/u.test(text.trim())) return
    event.preventDefault()
    onChange(splitRecoveryPhrase(text).join(' ').trimEnd())
  }

  const filled = words.filter((w) => w !== '').length
  const complete = filled === RECOVERY_WORD_COUNT
  const checksumFails = complete && !isValidRecoveryPhrase(words.join(' '))

  return (
    <fieldset className={styles.wrap} disabled={disabled}>
      <legend className={styles.legend}>{label}</legend>
      <p className={styles.hint} id={`${id}-hint`}>
        Type or paste all 24 words. Pasting into any box fills the rest.
      </p>

      <ol className={styles.grid}>
        {words.slice(0, RECOVERY_WORD_COUNT).map((word, index) => {
          const unknown = word !== '' && !isRecoveryWord(word)
          const listId = `${id}-list-${index}`
          return (
            <li key={index} className={styles.cell}>
              <label className={styles.ordinal} htmlFor={`${id}-w${index}`}>
                {index + 1}
              </label>
              <input
                id={`${id}-w${index}`}
                className={unknown ? `${styles.input} ${styles.unknown}` : styles.input}
                type="text"
                inputMode="text"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                // A recovery phrase is not a password and not a username. `off` is the only
                // honest answer: browsers must not offer to remember these, and must not
                // autofill them from anything else.
                autoComplete="off"
                aria-describedby={`${id}-hint`}
                aria-invalid={unknown || undefined}
                value={word}
                list={listId}
                onChange={(e) => setWord(index, e.target.value)}
                onPaste={paste}
              />
              {/* A native datalist rather than a custom menu: it is keyboard accessible for
                  free, it works on mobile, and it cannot trap focus. The list is public, so
                  suggesting from it discloses nothing. */}
              <datalist id={listId}>
                {completeRecoveryWord(word).map((suggestion) => (
                  <option key={suggestion} value={suggestion} />
                ))}
              </datalist>
            </li>
          )
        })}
      </ol>

      <p className={styles.status} aria-live="polite">
        {checksumFails
          ? 'All 24 words are real, but they do not check out together — usually one word is ' +
            'mistyped or two are swapped. BIP-39 catches that before anything is decrypted.'
          : `${filled} of ${RECOVERY_WORD_COUNT} words`}
      </p>
    </fieldset>
  )
}
