'use client'

import styles from './auth.module.css'

/**
 * "Confirm it is you with" — the password-or-phrase chooser, and the field it selects.
 *
 * Extracted after the second copy diverged from the first on the day it was written: the
 * passkey card's fields were missing `required`, so pressing Enter on an empty box ran a
 * full Argon2id derivation and came back with "that password did not open your calendar".
 * Two copies of a form is usually fine; two copies that already disagree about validation
 * are one copy and one bug.
 *
 * The `messageFor` ladders these callers own are deliberately NOT shared. ChangePassword
 * says "that CURRENT password" and the passkey card says "that password", and those
 * differences are correct — a shared ladder would either flatten them or grow a context
 * argument, which is worse than a few short functions.
 */
export type Proof = 'password' | 'phrase'

export function ProofFieldset({
  idPrefix,
  proof,
  onChange,
  disabled,
  passwordLabel,
  password,
  onPassword,
  phrase,
  onPhrase,
}: {
  /** Ids must be unique per page: /settings/security renders two of these. */
  idPrefix: string
  proof: Proof
  onChange: (next: Proof) => void
  disabled: boolean
  /** "Current password" where a new one is being set, plain "Password" otherwise. */
  passwordLabel: string
  password: string
  onPassword: (next: string) => void
  phrase: string
  onPhrase: (next: string) => void
}) {
  return (
    <>
      <fieldset className={styles.choice}>
        <legend className={styles.label}>Confirm it is you with</legend>
        <label className={styles.choiceRow}>
          <input
            type="radio"
            name={`${idPrefix}-proof`}
            value="password"
            checked={proof === 'password'}
            disabled={disabled}
            onChange={() => onChange('password')}
          />
          {passwordLabel === 'Password' ? 'My password' : 'My current password'}
        </label>
        <label className={styles.choiceRow}>
          <input
            type="radio"
            name={`${idPrefix}-proof`}
            value="phrase"
            checked={proof === 'phrase'}
            disabled={disabled}
            onChange={() => onChange('phrase')}
          />
          My recovery phrase
        </label>
      </fieldset>

      {proof === 'password' ? (
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${idPrefix}-password`}>
            {passwordLabel}
          </label>
          <input
            id={`${idPrefix}-password`}
            className={styles.input}
            type="password"
            required
            autoComplete="current-password"
            disabled={disabled}
            value={password}
            onChange={(event) => onPassword(event.target.value)}
          />
        </div>
      ) : (
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${idPrefix}-phrase`}>
            Your 24-word recovery phrase
          </label>
          <textarea
            id={`${idPrefix}-phrase`}
            className={styles.textarea}
            required
            rows={3}
            autoCapitalize="none"
            spellCheck={false}
            disabled={disabled}
            value={phrase}
            onChange={(event) => onPhrase(event.target.value)}
          />
        </div>
      )}
    </>
  )
}
