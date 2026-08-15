'use client'

import { useEffect, useState } from 'react'
import {
  LastWrapError,
  WrapEmailMismatchError,
  WrongPasswordError,
  WrongRecoveryPhraseError,
  listPasskeys,
  registerPasskeyWrap,
  removePasskeyWrap,
  rootKeyFromPassword,
  rootKeyFromRecoveryPhrase,
  type PasskeySummary,
} from '@/lib/cloak-session'
import {
  PasskeyCancelledError,
  PasskeyNoPrfError,
  PasskeyUnsupportedError,
  isPasskeySupported,
} from '@/lib/passkey'
import { ProofFieldset, type Proof } from './proof-fieldset'
import { InlineError } from './ui/inline-error'
import { Button } from './ui/button'
import styles from './auth.module.css'
import panel from './panel.module.css'

/**
 * Passkeys — the third way into an account, and the reason a forgotten password stops
 * meaning twenty-four words.
 *
 * WHY THIS ASKS FOR YOUR PASSWORD TO ADD ONE. Same reason ChangePassword does, and it is
 * worth restating because it looks redundant twice on one page: the key persisted at last
 * unlock is non-extractable, and writing a new wrap needs the root key's raw bytes. So
 * adding a passkey means proving you can already open the account. That is also the right
 * bar — a new passkey is a permanent way in, and minting one should cost what opening the
 * account costs.
 *
 * WHY A FORM CARD AND NOT A LIST PANEL. Two grammars live on /settings/security: form cards
 * (ChangePassword, ReissueRecoveryPhrase) wear `.title`, list panels (Devices) wear
 * `.panelTitle`. This is both — a list of what you have and a form to add one — and the
 * form is the errand people come for, so it takes the form grammar and sits beside its
 * siblings rather than starting a third shape.
 */

export function PasskeysSection({ email, demo }: { email: string; demo: boolean }) {
  /**
   * null means "not known yet", and the control renders DISABLED rather than absent while
   * it is. Same mount-deferred idiom as the theme radios: the server cannot know what this
   * browser supports, and guessing paints the wrong state for a frame.
   *
   * Disabled-in-place rather than a placeholder, deliberately. A control that is missing
   * until mount is a control the accessibility sweep and the 44px target sweep never
   * measure, and both of those run against this page.
   */
  const [supported, setSupported] = useState<boolean | null>(null)
  const [passkeys, setPasskeys] = useState<readonly PasskeySummary[] | null>(null)

  const [proof, setProof] = useState<Proof>('password')
  const [password, setPassword] = useState('')
  const [phrase, setPhrase] = useState('')
  const [working, setWorking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmingRemoval, setConfirmingRemoval] = useState<string | null>(null)
  /** Which row is being removed, so three registered passkeys do not all grey out at once. */
  const [removing, setRemoving] = useState<string | null>(null)

  useEffect(() => {
    setSupported(isPasskeySupported())
  }, [])

  // The demo has no session, so there is nothing to list and the read would fail on RLS.
  useEffect(() => {
    if (demo) {
      setPasskeys([])
      return
    }
    let live = true
    void listPasskeys()
      .then((found) => {
        if (live) setPasskeys(found)
      })
      .catch(() => {
        if (live) setPasskeys([])
      })
    return () => {
      live = false
    }
  }, [demo])

  const busy = working !== null
  const disabled = demo || supported !== true || busy

  const openRootKey = async () =>
    proof === 'password'
      ? rootKeyFromPassword(email, password)
      : rootKeyFromRecoveryPhrase(phrase)

  const add = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    setNotice(null)
    let registered = false

    try {
      setWorking('Opening your calendar')
      const rootKey = await openRootKey()

      /**
       * TWO PROMPTS, AND THE LABEL HAS TO SAY SO.
       *
       * PRF output is not reliably returned from `create()` — Safari hands back
       * `enabled: true` and no results — so registering means creating the credential and
       * then immediately asserting against it. The user gets two biometric prompts back to
       * back, and without this line the second one reads as the first having failed.
       */
      setWorking('Confirm twice: once to make the passkey, once to derive its key')
      await registerPasskeyWrap(rootKey, email, `CloakCal (${email})`)

      setPassword('')
      setPhrase('')
      setNotice('That passkey can now open your calendar.')
      registered = true
    } catch (caught) {
      // Cancelling a prompt is a normal outcome, not a failure. It goes to the neutral
      // notice rather than to InlineError, which is role="alert" and styled as danger.
      if (caught instanceof PasskeyCancelledError) setNotice(caught.message)
      else setError(messageFor(caught))
    } finally {
      setWorking(null)
    }

    // OUTSIDE the try, deliberately. A transient failure refreshing the list is not a failed
    // registration, and reporting it as one next to "that passkey can now open your calendar"
    // invites someone to register a second credential they did not want.
    if (registered) await refresh()
  }

  const refresh = async () => {
    try {
      setPasskeys(await listPasskeys())
    } catch {
      // Leave the previous list on screen rather than blanking it; it is stale, not wrong.
    }
  }

  const remove = async (wrapId: string) => {
    setError(null)
    setNotice(null)
    setRemoving(wrapId)
    try {
      await removePasskeyWrap(wrapId)
      setConfirmingRemoval(null)
      await refresh()
    } catch (caught) {
      setError(messageFor(caught))
    } finally {
      setRemoving(null)
    }
  }

  return (
    <form className={panel.band} onSubmit={add}>
      <h2 className={panel.panelTitle}>Passkeys</h2>
      <p className={panel.panelLede}>
        A passkey lets your face, fingerprint or device PIN open your calendar, and reset
        your password without the recovery phrase. Your events are not re-encrypted: a
        passkey wraps the same key everything else opens.
      </p>

      <InlineError>{error}</InlineError>

      {notice !== null && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}

      {demo && (
        <p className={styles.hint}>Demo. Sign in to add a passkey.</p>
      )}

      {/* Once mounted and genuinely unsupported, a sentence rather than a permanently grey
          button: a control that can never work should say why, not sit there greyed. */}
      {supported === false && !demo && (
        <p className={styles.hint}>
          This browser cannot derive an encryption key from a passkey, so adding one here
          would give you a passkey that opens nothing. Your password and recovery phrase
          still work.
        </p>
      )}

      {passkeys !== null && passkeys.length > 0 && (
        <ul className={styles.keyList} aria-label="Your passkeys">
          {passkeys.map((passkey) => (
            <li key={passkey.id} className={styles.keyRow}>
              {/* The short credential id is what the SERVER files this passkey under, the
                  same convention the People register uses for contacts. There is no label
                  column, and inventing a friendly name the server would then store is a
                  plaintext detail we do not need. */}
              <span>Added {passkey.createdAt.slice(0, 10)}</span>
              <code>{passkey.shortId}</code>
              {confirmingRemoval === passkey.id ? (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={removing !== null}
                    onClick={() => setConfirmingRemoval(null)}
                  >
                    Keep
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    busy={removing === passkey.id}
                    disabled={removing !== null}
                    onClick={() => void remove(passkey.id)}
                  >
                    Remove
                  </Button>
                </>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={removing !== null}
                  onClick={() => setConfirmingRemoval(passkey.id)}
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {confirmingRemoval !== null && (
        <p className={styles.warning} role="alert">
          Removing a passkey deletes the copy of your key that it opened. It does not change
          the key itself, so anything that already held a copy still holds one. Your other
          ways in are unaffected.
        </p>
      )}

      <div className={styles.form}>
        <ProofFieldset
          idPrefix="passkey"
          proof={proof}
          onChange={setProof}
          disabled={disabled}
          passwordLabel="Password"
          password={password}
          onPassword={setPassword}
          phrase={phrase}
          onPhrase={setPhrase}
        />

        {busy ? (
          <p className={styles.working} aria-live="polite">
            <span className={styles.pulse} aria-hidden="true" />
            {working}
          </p>
        ) : (
          <button type="submit" className={styles.submit} disabled={disabled}>
            Add a passkey
          </button>
        )}
      </div>
    </form>
  )
}

/**
 * Typed errors first, raw message as the honest fallback — the same ladder ChangePassword
 * and RecoverForm use. Every one of these carries an instruction the user can act on, so
 * none of them may be flattened into a generic failure.
 */
function messageFor(caught: unknown): string {
  if (caught instanceof WrongPasswordError) {
    return 'That password did not open your calendar. If it is the one you sign in with, use your recovery phrase instead.'
  }
  if (caught instanceof WrongRecoveryPhraseError) return caught.message
  if (caught instanceof WrapEmailMismatchError) return caught.message
  if (caught instanceof LastWrapError) return caught.message
  if (caught instanceof PasskeyNoPrfError) return caught.message
  if (caught instanceof PasskeyUnsupportedError) return caught.message
  return caught instanceof Error ? caught.message : String(caught)
}
