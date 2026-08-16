'use client'

import { useEffect, useState } from 'react'
import {
  WrapEmailMismatchError,
  WrongPasswordError,
  WrongRecoveryPhraseError,
  hasPasskey,
  signInAndUnlock,
  signOut,
  unlockWithPasskey,
  unlockWithRecoveryPhrase,
} from '@/lib/cloak-session'
import {
  PasskeyCancelledError,
  PasskeyNoPrfError,
  isPasskeySupported,
} from '@/lib/passkey'
import { InlineError } from './ui/inline-error'
import { Button } from './ui/button'
import styles from './auth.module.css'

/**
 * Unlock, in place, over the calendar.
 *
 * It sits ON the calendar rather than replacing it, and that is a deliberate disclosure
 * rather than a layout convenience. Behind the scrim are the times, durations and repeat
 * patterns of every event — which is exactly the set of facts the server holds in plaintext
 * under the hybrid model (plan D1). Showing that a locked calendar still has a visible
 * shape is more honest than a blank screen implying the server knows nothing.
 *
 * A PASSKEY IS OFFERED FIRST when the account has one, because that is the entire point of
 * having one. It is an action rather than a field, so it sits above the form instead of
 * joining the password/phrase toggle, which stays binary.
 */

export function UnlockPanel({ email, onUnlocked }: { email: string; onUnlocked: () => void }) {
  const [mode, setMode] = useState<'password' | 'recovery'>('password')
  const [password, setPassword] = useState('')
  const [phrase, setPhrase] = useState('')
  /**
   * `string | null`, not a boolean, and that is not tidying.
   *
   * The old boolean rendered one hardcoded line: "Deriving your key". On the passkey path
   * nothing is derived — the app is idle, waiting on the operating system — so the only
   * honest label is a different one, and a boolean cannot carry it. The other three auth
   * surfaces already use this shape; this file was the outlier.
   */
  const [working, setWorking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [passkeyOffered, setPasskeyOffered] = useState(false)

  /**
   * Whether to OFFER the passkey route. Two questions, and both have to be yes: can this
   * browser do it, and does this account have one. Asking the account costs a round trip on
   * mount, which buys not raising a biometric prompt that cannot possibly succeed.
   */
  useEffect(() => {
    if (!isPasskeySupported()) return
    let live = true
    void hasPasskey()
      .then((has) => {
        if (live) setPasskeyOffered(has)
      })
      .catch(() => {
        // A failed read means we simply do not offer it. The password path is unaffected,
        // and an error here would be about a feature the user has not asked for yet.
      })
    return () => {
      live = false
    }
  }, [])

  const busy = working !== null

  const runPasskey = async () => {
    setError(null)
    setNotice(null)
    setWorking('Waiting for your passkey')
    try {
      await unlockWithPasskey(email)
      onUnlocked()
    } catch (caught) {
      // Cancelling is a normal outcome, not a failure: neutral notice, not role="alert".
      if (caught instanceof PasskeyCancelledError) setNotice(caught.message)
      else setError(messageFor(caught))
    } finally {
      setWorking(null)
      // Deliberately does NOT clear `password` or `phrase`. A cancelled passkey attempt
      // wiping a half-typed password would be its own small betrayal.
    }
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    setNotice(null)
    setWorking('Deriving your key')

    try {
      if (mode === 'password') await signInAndUnlock(email, password)
      else await unlockWithRecoveryPhrase(email, phrase)
      onUnlocked()
    } catch (caught) {
      setError(messageFor(caught))
    } finally {
      setWorking(null)
      setPassword('')
      setPhrase('')
    }
  }

  return (
    <div className={styles.lockScrim} role="dialog" aria-modal="true" aria-labelledby="unlock-title">
      <form className={styles.lockCard} onSubmit={submit}>
        <h2 id="unlock-title" className={styles.title}>
          Locked
        </h2>
        <p className={styles.lede}>
          Your events are here, sealed. CloakCal cannot open them and neither can this page until
          you provide the key. The times behind this panel are what our servers can see.
        </p>

        <InlineError>{error}</InlineError>

        {notice !== null && (
          <p className={styles.notice} role="status">
            {notice}
          </p>
        )}

        {passkeyOffered && (
          <>
            <Button
              className={styles.fullWidth}
              disabled={busy}
              onClick={() => void runPasskey()}
            >
              Unlock with a passkey
            </Button>
            <p className={styles.switch} aria-hidden="true">
              or
            </p>
          </>
        )}

        <div className={styles.form}>
          {mode === 'password' ? (
            <div className={styles.field}>
              <label className={styles.label} htmlFor="unlock-password">
                Password for {email}
              </label>
              <input
                id="unlock-password"
                className={styles.input}
                type="password"
                required
                autoFocus
                autoComplete="current-password"
                disabled={busy}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          ) : (
            <div className={styles.field}>
              <label className={styles.label} htmlFor="unlock-phrase">
                Recovery phrase (24 words)
              </label>
              <textarea
                id="unlock-phrase"
                className={styles.textarea}
                required
                autoFocus
                autoCapitalize="none"
                spellCheck={false}
                disabled={busy}
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
              />
            </div>
          )}

          {busy ? (
            <p className={styles.working} aria-live="polite">
              <span className={styles.pulse} aria-hidden="true" />
              {working}
            </p>
          ) : (
            <Button type="submit" className={styles.fullWidth}>
              Unlock
            </Button>
          )}
        </div>

        {/* A mode switch, not an action: ghost so it cannot compete with Unlock above it. */}
        <Button
          variant="ghost"
          className={styles.fullWidth}
          disabled={busy}
          onClick={() => {
            setError(null)
            setMode(mode === 'password' ? 'recovery' : 'password')
          }}
        >
          {mode === 'password' ? 'Use my recovery phrase instead' : 'Use my password instead'}
        </Button>

        <p className={styles.switch}>
          <a
            href="/sign-in"
            onClick={(e) => {
              e.preventDefault()
              void signOut().then(() => window.location.assign('/sign-in'))
            }}
          >
            Sign out
          </a>
        </p>
      </form>
    </div>
  )
}

/**
 * This panel had no error mapping at all — it surfaced `caught.message` raw, which was
 * survivable while every error here came from our own code and already read as English.
 * A passkey adds errors whose default text is right for a form and wrong for a lock screen,
 * so the ladder every other auth surface uses arrives here too: typed errors first, raw
 * message as the honest fallback.
 */
function messageFor(caught: unknown): string {
  if (caught instanceof WrongPasswordError) return caught.message
  if (caught instanceof WrongRecoveryPhraseError) return caught.message
  if (caught instanceof WrapEmailMismatchError) return caught.message
  if (caught instanceof PasskeyNoPrfError) {
    return 'That passkey would not derive your key on this device. Use your password or your recovery phrase.'
  }
  return caught instanceof Error ? caught.message : String(caught)
}
