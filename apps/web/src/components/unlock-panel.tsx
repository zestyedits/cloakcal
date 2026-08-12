'use client'

import { useState } from 'react'
import { signInAndUnlock, signOut, unlockWithRecoveryPhrase } from '@/lib/cloak-session'
import { InlineError } from './ui/inline-error'
import styles from './auth.module.css'

/**
 * Unlock, in place, over the calendar.
 *
 * It sits ON the calendar rather than replacing it, and that is a deliberate disclosure
 * rather than a layout convenience. Behind the scrim are the times, durations and repeat
 * patterns of every event — which is exactly the set of facts the server holds in plaintext
 * under the hybrid model (plan D1). Showing that a locked calendar still has a visible
 * shape is more honest than a blank screen implying the server knows nothing.
 */

export function UnlockPanel({ email, onUnlocked }: { email: string; onUnlocked: () => void }) {
  const [mode, setMode] = useState<'password' | 'recovery'>('password')
  const [password, setPassword] = useState('')
  const [phrase, setPhrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    setBusy(true)

    try {
      if (mode === 'password') await signInAndUnlock(email, password)
      else await unlockWithRecoveryPhrase(email, phrase)
      onUnlocked()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
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
              Deriving your key
            </p>
          ) : (
            <button type="submit" className={styles.submit}>
              Unlock
            </button>
          )}
        </div>

        <button
          type="button"
          className={styles.secondary}
          disabled={busy}
          onClick={() => {
            setError(null)
            setMode(mode === 'password' ? 'recovery' : 'password')
          }}
        >
          {mode === 'password' ? 'Use my recovery phrase instead' : 'Use my password instead'}
        </button>

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
