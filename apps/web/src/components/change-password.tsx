'use client'

import { useState } from 'react'
import {
  RewrapHalfAppliedError,
  WrapEmailMismatchError,
  WrongPasswordError,
  WrongRecoveryPhraseError,
  rewrapPasswordWrap,
  rootKeyFromPassword,
  rootKeyFromRecoveryPhrase,
} from '@/lib/cloak-session'
import { ProofFieldset, type Proof } from './proof-fieldset'
import { InlineError } from './ui/inline-error'
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
    /* No lockup, no h1, no back link. This used to carry a whole page's chrome with it,
       which was fine when it WAS a page (/account) and became two h1s and a stray brand
       mark mid-scroll the moment it was rendered inside something else. Its page is
       /settings/security now, and a page owns its own chrome. */
    <form className={styles.card} onSubmit={submit}>
      <h2 className={styles.title}>Change your password</h2>
      <p className={styles.lede}>
        Your events are not re-encrypted. Your password wraps the key that opens them, so only
        the wrapper changes. Nothing about your calendar is rewritten, and your recovery
        phrase keeps working.
      </p>

      <InlineError>{error}</InlineError>

      {done && (
        <p className={styles.notice} role="status">
          Done. Use your new password next time you sign in.
        </p>
      )}

      <div className={styles.form}>
        <ProofFieldset
          idPrefix="current"
          proof={proof}
          onChange={setProof}
          disabled={busy}
          passwordLabel="Current password"
          password={current}
          onPassword={setCurrent}
          phrase={phrase}
          onPhrase={setPhrase}
        />

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
            {working}. This takes a moment on purpose. A slow derivation is what makes a
            stolen database expensive to attack.
          </p>
        ) : (
          <button type="submit" className={styles.submit}>
            Change password
          </button>
        )}
      </div>

    </form>
  )
}

function messageFor(caught: unknown): string {
  if (caught instanceof WrongPasswordError) {
    return 'That current password did not open your calendar. If it is the one you sign in with, use your recovery phrase instead.'
  }
  if (caught instanceof WrongRecoveryPhraseError) return caught.message
  // Both carry an instruction the user can act on; do not flatten either into a generic
  // failure. The mismatch one names the address the key was actually derived under, which
  // is the only thing that makes an unopenable wrap explicable rather than maddening.
  if (caught instanceof WrapEmailMismatchError) return caught.message
  if (caught instanceof RewrapHalfAppliedError) return caught.message
  return caught instanceof Error ? caught.message : String(caught)
}
