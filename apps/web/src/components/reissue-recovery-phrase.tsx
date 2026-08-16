'use client'

import { useState } from 'react'
import {
  WrongPasswordError,
  WrongRecoveryPhraseError,
  reissueRecoveryPhrase,
  rootKeyFromPassword,
  rootKeyFromRecoveryPhrase,
} from '@/lib/cloak-session'
import { RecoveryPhrase } from './recovery-phrase'
import { RecoveryPhraseInput } from './recovery-phrase-input'
import { InlineError } from './ui/inline-error'
import { Button } from './ui/button'
import styles from './auth.module.css'
import panel from './panel.module.css'

/**
 * Get a new recovery phrase.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS HAS TO EXIST
 * ---------------------------------------------------------------------------
 *
 * The phrase is shown once and never stored, which is right. But without a way to issue a
 * new one, losing the paper while still signed in put the account in the worst possible
 * state: already unrecoverable, and looking completely fine. The failure is discovered on the
 * day it cannot be fixed — one logout, one cleared browser, one new laptop.
 *
 * That is strictly worse than never having written it down, because there is no signal.
 *
 * ---------------------------------------------------------------------------
 * WHY IT ASKS FOR YOUR PASSWORD WHEN YOU ARE ALREADY SIGNED IN
 * ---------------------------------------------------------------------------
 *
 * Two reasons, and the first is mechanical: a resumed session holds a non-extractable key,
 * and wrapping the root key needs its raw bytes. There is no path back to them from a
 * resumed session — that is the property stopping a stolen laptop from exporting the key.
 *
 * The second is the one that matters. This mints a permanent, password-independent way into
 * the account. An unlocked laptop left open for two minutes should not be enough to walk
 * away with one.
 *
 * ---------------------------------------------------------------------------
 * THE OLD PHRASE STOPS WORKING, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 *
 * Rotation overwrites the single recovery wrap. Anyone holding the previous 24 words —
 * including whoever found the paper you lost — loses access at that moment. Said plainly in
 * the copy, because a user who thinks both sets work has misunderstood what they just did.
 *
 * Nothing is re-encrypted: the root key is unchanged, so events, the password wrap and any
 * device wraps are all untouched.
 */

type Proof = 'password' | 'phrase'

export function ReissueRecoveryPhrase({ email }: { email: string }) {
  const [open, setOpen] = useState(false)
  const [proof, setProof] = useState<Proof>('password')
  const [password, setPassword] = useState('')
  const [phrase, setPhrase] = useState('')
  const [working, setWorking] = useState<string | null>(null)
  const [issued, setIssued] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)

    try {
      setWorking('Opening your calendar')
      const rootKey =
        proof === 'password'
          ? await rootKeyFromPassword(email, password)
          : await rootKeyFromRecoveryPhrase(phrase)

      setWorking('Issuing a new phrase')
      const next = await reissueRecoveryPhrase(rootKey)

      // Clear both proofs the moment they are spent. Neither is needed again, and leaving a
      // password in component state for the length of the ceremony is free risk.
      setPassword('')
      setPhrase('')
      setIssued(next)
    } catch (caught) {
      if (caught instanceof WrongPasswordError) setError('That password did not open your calendar.')
      else if (caught instanceof WrongRecoveryPhraseError) setError('That phrase did not match.')
      else setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setWorking(null)
    }
  }

  // The same ceremony as first-run: read it, then type three words back. A "yes I saved it"
  // checkbox measures nothing, and this phrase matters exactly as much as the original.
  if (issued !== null) {
    return (
      <div className={panel.band}>
        <RecoveryPhrase
          phrase={issued}
          onConfirmed={() => {
            setIssued(null)
            setOpen(false)
          }}
        />
      </div>
    )
  }

  if (!open) {
    return (
      <div className={panel.band}>
        <h2 className={panel.panelTitle}>Recovery phrase</h2>
        <p className={panel.panelLede}>
          Lost the 24 words, or think someone else has seen them? Get a new set. The old ones
          stop working immediately.
        </p>
        <Button variant="outline" className={styles.fullWidth} onClick={() => setOpen(true)}>
          Get a new recovery phrase
        </Button>
      </div>
    )
  }

  return (
    <form className={panel.band} onSubmit={submit}>
      <h2 className={panel.panelTitle}>Get a new recovery phrase</h2>
      <p className={panel.panelLede}>
        Your events are not touched and your password does not change. The{' '}
        <strong>old 24 words stop working</strong> the moment the new ones are issued. If
        you are doing this because someone saw them, this is the thing that shuts them out.
      </p>

      <fieldset className={styles.choice}>
        <legend className={styles.label}>Confirm it is you with</legend>
        <label className={styles.choiceRow}>
          <input
            type="radio"
            name="reissue-proof"
            checked={proof === 'password'}
            disabled={working !== null}
            onChange={() => setProof('password')}
          />
          My password
        </label>
        <label className={styles.choiceRow}>
          <input
            type="radio"
            name="reissue-proof"
            checked={proof === 'phrase'}
            disabled={working !== null}
            onChange={() => setProof('phrase')}
          />
          My current recovery phrase
        </label>
      </fieldset>

      {proof === 'password' ? (
        <div className={styles.field}>
          <label className={styles.label} htmlFor="reissue-password">
            Password
          </label>
          <input
            id="reissue-password"
            className={styles.input}
            type="password"
            autoComplete="current-password"
            required
            value={password}
            disabled={working !== null}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
      ) : (
        <div className={styles.field}>
          <RecoveryPhraseInput
            label="Current recovery phrase"
            value={phrase}
            disabled={working !== null}
            onChange={setPhrase}
          />
        </div>
      )}

      <InlineError>{error}</InlineError>

      <Button type="submit" className={styles.fullWidth} busy={working !== null}>
        {working ?? 'Issue a new phrase'}
      </Button>
      <Button
        variant="ghost"
        className={styles.fullWidth}
        disabled={working !== null}
        onClick={() => {
          setOpen(false)
          setPassword('')
          setPhrase('')
          setError(null)
        }}
      >
        Cancel
      </Button>
    </form>
  )
}
