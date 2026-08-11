'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  RewrapHalfAppliedError,
  WrongPasswordError,
  WrongRecoveryPhraseError,
  rewrapPasswordWrap,
  rootKeyFromPassword,
  rootKeyFromRecoveryPhrase,
} from '@/lib/cloak-session'
import { CloakLockup } from './cloak-logo'
import styles from './auth.module.css'

/**
 * Change your password, deliberately.
 *
 * WHY THIS ASKS FOR SOMETHING YOU ALREADY PROVED. You are signed in and your calendar is
 * probably unlocked, so being asked for the current password looks redundant. It is not:
 * the key persisted at last unlock is deliberately NON-EXTRACTABLE, and re-wrapping needs
 * the root key's raw bytes. There is no path from a resumed session back to those bytes —
 * that is the property that stops a stolen laptop session from exporting the key, and it
 * costs one password prompt here.
 *
 * The recovery phrase is offered as the alternative for the case that actually matters: a
 * password that authenticates but no longer opens the calendar, which is what a half-applied
 * change or a dashboard-side password reset leaves behind. Without this second option that
 * state would be a dead end for a signed-in user.
 */

type Proof = 'password' | 'phrase'

export function ChangePassword({ email }: { email: string }) {
  const [proof, setProof] = useState<Proof>('password')
  const [current, setCurrent] = useState('')
  const [phrase, setPhrase] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [working, setWorking] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    setDone(false)

    if (password !== confirm) {
      setError('Those passwords do not match.')
      return
    }
    if (proof === 'password' && password === current) {
      setError('That is the password you already have. Choose a different one.')
      return
    }

    try {
      setWorking('Opening your calendar')
      const rootKey =
        proof === 'password'
          ? await rootKeyFromPassword(email, current)
          : await rootKeyFromRecoveryPhrase(phrase)

      setWorking('Re-locking it to your new password')
      await rewrapPasswordWrap(rootKey, email, password)

      setWorking(null)
      setDone(true)
      setCurrent('')
      setPhrase('')
      setPassword('')
      setConfirm('')
    } catch (caught) {
      setError(messageFor(caught))
      setWorking(null)
    }
  }

  const busy = working !== null

  return (
    <form className={styles.card} onSubmit={submit}>
      <CloakLockup />

      <h1 className={styles.title}>Change your password</h1>
      <p className={styles.lede}>
        Your events are not re-encrypted. Your password wraps the key that opens them, so only
        the wrapper changes — nothing about your calendar is rewritten, and your recovery
        phrase keeps working.
      </p>

      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {done && (
        <p className={styles.notice} role="status">
          Done. Use your new password next time you sign in.
        </p>
      )}

      <div className={styles.form}>
        <fieldset className={styles.choice}>
          <legend className={styles.label}>Confirm it is you with</legend>
          <label className={styles.choiceRow}>
            <input
              type="radio"
              name="proof"
              value="password"
              checked={proof === 'password'}
              disabled={busy}
              onChange={() => setProof('password')}
            />
            My current password
          </label>
          <label className={styles.choiceRow}>
            <input
              type="radio"
              name="proof"
              value="phrase"
              checked={proof === 'phrase'}
              disabled={busy}
              onChange={() => setProof('phrase')}
            />
            My recovery phrase
          </label>
        </fieldset>

        {proof === 'password' ? (
          <div className={styles.field}>
            <label className={styles.label} htmlFor="current-password">
              Current password
            </label>
            <input
              id="current-password"
              className={styles.input}
              type="password"
              required
              autoComplete="current-password"
              disabled={busy}
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </div>
        ) : (
          <div className={styles.field}>
            <label className={styles.label} htmlFor="current-phrase">
              Your 24-word recovery phrase
            </label>
            <textarea
              id="current-phrase"
              className={styles.textarea}
              required
              rows={3}
              autoCapitalize="none"
              spellCheck={false}
              disabled={busy}
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
            />
          </div>
        )}

        <div className={styles.field}>
          <label className={styles.label} htmlFor="new-password">
            New password
          </label>
          <input
            id="new-password"
            className={styles.input}
            type="password"
            required
            minLength={10}
            autoComplete="new-password"
            disabled={busy}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="new-password-confirm">
            Confirm new password
          </label>
          <input
            id="new-password-confirm"
            className={styles.input}
            type="password"
            required
            minLength={10}
            autoComplete="new-password"
            disabled={busy}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>

        {busy ? (
          <p className={styles.working} aria-live="polite">
            <span className={styles.pulse} aria-hidden="true" />
            {working}. This takes a moment on purpose — a slow derivation is what makes a
            stolen database expensive to attack.
          </p>
        ) : (
          <button type="submit" className={styles.submit}>
            Change password
          </button>
        )}
      </div>

      <p className={styles.switch}>
        <Link href="/">Back to your calendar</Link>
      </p>
    </form>
  )
}

function messageFor(caught: unknown): string {
  if (caught instanceof WrongPasswordError) {
    return 'That current password did not open your calendar. If it is the one you sign in with, use your recovery phrase instead.'
  }
  if (caught instanceof WrongRecoveryPhraseError) return caught.message
  // Carries an instruction the user can act on; do not flatten it.
  if (caught instanceof RewrapHalfAppliedError) return caught.message
  return caught instanceof Error ? caught.message : String(caught)
}
