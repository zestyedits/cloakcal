'use client'

import { useMemo, useState } from 'react'
import { normalizeRecoveryPhrase } from '@cloakcal/crypto'
import styles from './auth.module.css'

/**
 * The recovery phrase ceremony.
 *
 * Shown once. There is no second copy — not on our servers, not in this component's state
 * after it unmounts. That is the whole design (D7, ADR 0002): CloakCal holds no wrap it can
 * open, so a phrase we could re-show would have to be a phrase we had stored.
 *
 * TWO THINGS THIS SCREEN REFUSES TO DO.
 *
 * It does not offer a copy button. A phrase on the clipboard is readable by every other
 * page the user visits until something else overwrites it, and it lands in clipboard
 * history on both Windows and macOS. Writing it down is slower and genuinely safer, and the
 * one time this matters it is worth the friction.
 *
 * It does not accept "I'll do this later". An account with a password wrap and no confirmed
 * recovery phrase looks protected and is one forgotten password from unrecoverable. The
 * confirmation below asks for three words back, chosen at random, because a "yes I wrote it
 * down" checkbox measures nothing.
 */

const CONFIRM_COUNT = 3

export function RecoveryPhrase({
  phrase,
  onConfirmed,
}: {
  phrase: string
  onConfirmed: () => void
}) {
  const words = useMemo(() => phrase.split(' '), [phrase])

  // Chosen once per mount so the challenge cannot be rerolled until it lands on words the
  // user happens to remember.
  const challenge = useMemo(() => {
    const indices = new Set<number>()
    while (indices.size < CONFIRM_COUNT) {
      indices.add(Math.floor(Math.random() * words.length))
    }
    return [...indices].sort((a, b) => a - b)
  }, [words.length])

  const [stage, setStage] = useState<'read' | 'confirm'>('read')

  /**
   * Save the phrase as a file.
   *
   * THE NO-COPY-BUTTON RULE STILL STANDS, and this does not break it. A clipboard is readable
   * by every other page you visit until something overwrites it, and it lands in OS clipboard
   * history on both Windows and macOS — a phrase sitting there is exposed to software that was
   * never given it. A file the user chooses where to put is a deliberate act with a location
   * they picked, which is a different risk they can reason about.
   *
   * The alternative being defended against is not "clipboard" — it is somebody typing 24 words
   * onto a sticky note, or not writing them down at all and losing the calendar. Print it, put
   * it in a password manager, put it in a safe. All strictly better than nothing, which is what
   * "paper only" gets from most people.
   *
   * Numbered, because that is what `splitRecoveryPhrase` strips back out on the way in — so a
   * user can paste this file straight into the recovery form.
   *
   * Built with a blob URL and revoked immediately: nothing is uploaded, and the phrase never
   * touches a server. `download` keeps it out of the address bar and out of history.
   */
  const downloadKit = () => {
    const numbered = words.map((word, index) => `${String(index + 1).padStart(2, ' ')}. ${word}`)
    const kit = [
      'CloakCal recovery kit',
      '',
      'These 24 words are the only way back into your calendar if you forget your',
      'password. Anyone who has them can read every event in it.',
      '',
      'Keep this somewhere you would keep a passport. Print it, or put it in a',
      'password manager. Do not email it to yourself.',
      '',
      ...numbered,
      '',
      'To use it: cloakcal.com/recover — you can paste this whole file into the form.',
      '',
      'CloakCal cannot recover this for you. We never see your phrase or your password,',
      'which is what stops us, or anyone who breaks into our servers, reading your events.',
      'It is also why losing both means the content is gone.',
      '',
    ].join('\n')

    const url = URL.createObjectURL(new Blob([kit], { type: 'text/plain;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'cloakcal-recovery-kit.txt'
    link.click()
    URL.revokeObjectURL(url)
  }
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const [error, setError] = useState<string | null>(null)

  const check = (event: React.FormEvent) => {
    event.preventDefault()
    const wrong = challenge.filter(
      (index) => normalizeRecoveryPhrase(answers[index] ?? '') !== words[index],
    )

    if (wrong.length > 0) {
      setError(
        wrong.length === 1
          ? `Word ${wrong[0]! + 1} does not match. Check your written copy.`
          : `${wrong.length} words do not match. Check your written copy.`,
      )
      return
    }
    onConfirmed()
  }

  if (stage === 'read') {
    return (
      <div className={styles.card}>
        <h1 className={styles.title}>Write these 24 words down</h1>
        <p className={styles.lede}>
          This is your recovery phrase. It is the only way back into your calendar if you forget
          your password.
        </p>

        <ol className={styles.phraseGrid}>
          {words.map((word, index) => (
            <li key={`${index}-${word}`} className={styles.phraseWord}>
              <span className={styles.phraseIndex} aria-hidden="true">
                {index + 1}
              </span>
              <span>{word}</span>
            </li>
          ))}
        </ol>

        <p className={styles.warning}>
          <strong>We cannot recover this for you.</strong> CloakCal never sees your phrase or your
          password, which is what stops us — or anyone who compromises our servers — from reading
          your events. It also means that if you lose both, your Cloaked content is gone. Write the
          phrase on paper and keep it somewhere you would keep a passport.
        </p>

        <button type="button" className={styles.secondary} onClick={downloadKit}>
          Download a copy
        </button>

        <button type="button" className={styles.submit} onClick={() => setStage('confirm')}>
          I have written it down
        </button>
      </div>
    )
  }

  return (
    <form className={styles.card} onSubmit={check}>
      <h1 className={styles.title}>Confirm your phrase</h1>
      <p className={styles.lede}>
        Type these three words from the phrase you just wrote down. You cannot see the phrase from
        here, which is the point.
      </p>

      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <div className={styles.form}>
        {challenge.map((index) => (
          <div key={index} className={styles.field}>
            <label className={styles.label} htmlFor={`word-${index}`}>
              Word {index + 1}
            </label>
            <input
              id={`word-${index}`}
              className={styles.input}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={answers[index] ?? ''}
              onChange={(e) => setAnswers((prev) => ({ ...prev, [index]: e.target.value }))}
            />
          </div>
        ))}
      </div>

      <button type="submit" className={styles.submit}>
        Confirm and open my calendar
      </button>
      <button type="button" className={styles.secondary} onClick={() => setStage('read')}>
        Show me the phrase again
      </button>
    </form>
  )
}
