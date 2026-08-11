'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  RewrapHalfAppliedError,
  WrongRecoveryPhraseError,
  rewrapPasswordWrap,
  rootKeyFromRecoveryPhrase,
} from '@/lib/cloak-session'
import { supabaseBrowser } from '@/lib/supabase/client'
import styles from './auth.module.css'

/**
 * Getting back in without your password.
 *
 * WHY THERE IS AN EMAIL STEP AT ALL. The 24-word phrase is cryptographically sufficient on
 * its own — it derives the key that opens the recovery wrap, and nothing else is needed to
 * decrypt. But the wrap itself sits behind RLS keyed to `auth.uid()`, so reading it needs a
 * session. The alternatives were a SECURITY DEFINER function or a service-role key, and both
 * are barred outright: the posture test asserts there are no definer functions at all, and
 * rule 4 forbids the service key. Either would also hand anyone who knows an email address a
 * wrap blob to attack offline, plus a way to test which addresses have accounts. A reset
 * email buys the session and weakens none of that.
 *
 * So: two screens on one route, chosen by whether a session exists.
 *
 *   signed out → collect an email, send the link
 *   signed in  → collect the phrase and a new password, rewrap, done
 *
 * THE PHRASE NEVER LEAVES THE BROWSER, exactly like the password. What reaches the server is
 * the newly wrapped key and a derived auth secret that cannot open it.
 *
 * `screen` and `working` are separate state on purpose. They answer different questions —
 * which form am I on, and is a request in flight — and folding them into one union made the
 * submit handler guess at the first from the second.
 */

type Screen = 'checking' | 'request' | 'sent' | 'reset'

export function RecoverForm() {
  const router = useRouter()

  const [screen, setScreen] = useState<Screen>('checking')
  const [working, setWorking] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [phrase, setPhrase] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)

  // The emailed link carries its token in the URL fragment, which supabase-js consumes on
  // load. That is asynchronous, so a session can appear a tick after mount — hence listening
  // rather than checking once and concluding nobody is here.
  useEffect(() => {
    const supabase = supabaseBrowser()
    let cancelled = false

    void supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) setScreen(data.session === null ? 'request' : 'reset')
    })

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (cancelled || session === null) return
      // Only ever moves forward. Sending a half-filled reset form back to the email step
      // because a token refreshed would discard a phrase the user just typed.
      setScreen((current) => (current === 'reset' ? current : 'reset'))
    })

    return () => {
      cancelled = true
      sub.subscription.unsubscribe()
    }
  }, [])

  const sendLink = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    setWorking('Sending your link')

    const { error: sendError } = await supabaseBrowser().auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${globalThis.location.origin}/recover`,
    })
    setWorking(null)

    // Rate limiting is worth saying out loud, because the user can act on it. Anything else
    // is deliberately NOT surfaced per-address: "no account with that email" would turn this
    // form into a way to discover who has a CloakCal account, and the vaguer phrasing costs
    // the real user nothing.
    if (sendError !== null && /rate|too many/i.test(sendError.message)) {
      setError('Too many attempts just now. Wait a minute and try again.')
      return
    }
    setScreen('sent')
  }

  const resetPassword = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)

    if (password !== confirm) {
      setError('Those passwords do not match.')
      return
    }

    try {
      setWorking('Opening your calendar')
      const rootKey = await rootKeyFromRecoveryPhrase(phrase)

      const { data } = await supabaseBrowser().auth.getUser()
      const address = data.user?.email ?? email.trim()

      setWorking('Re-locking it to your new password')
      await rewrapPasswordWrap(rootKey, address, password)

      // Straight to the calendar: the session is valid and the key is already open, so
      // bouncing through sign-in would only ask for the password just chosen.
      router.replace('/')
      router.refresh()
    } catch (caught) {
      setError(messageFor(caught))
      setWorking(null)
    }
  }

  const busy = working !== null

  return (
    <form className={styles.card} onSubmit={screen === 'reset' ? resetPassword : sendLink}>
      <div className={styles.brand}>
        <span className={styles.mark} aria-hidden="true" />
        <span className={styles.wordmark}>
          Cloak<span className={styles.wordmarkAccent}>Cal</span>
        </span>
      </div>

      <h1 className={styles.title}>{screen === 'sent' ? 'Check your email' : 'Get back in'}</h1>
      <p className={styles.lede}>{LEDE[screen]}</p>

      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {screen === 'checking' && (
        <p className={styles.working} aria-live="polite">
          <span className={styles.pulse} aria-hidden="true" />
          Checking your link
        </p>
      )}

      {screen === 'request' && (
        <div className={styles.form}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="recover-email">
              Email
            </label>
            <input
              id="recover-email"
              className={styles.input}
              type="email"
              required
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              disabled={busy}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          {busy ? (
            <p className={styles.working} aria-live="polite">
              <span className={styles.pulse} aria-hidden="true" />
              {working}
            </p>
          ) : (
            <button type="submit" className={styles.submit}>
              Email me a link
            </button>
          )}
        </div>
      )}

      {screen === 'reset' && (
        <div className={styles.form}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="recover-phrase">
              Your 24-word recovery phrase
            </label>
            <textarea
              id="recover-phrase"
              className={styles.textarea}
              required
              rows={3}
              autoCapitalize="none"
              spellCheck={false}
              disabled={busy}
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              aria-describedby="recover-phrase-hint"
            />
            <p id="recover-phrase-hint" className={styles.hint}>
              Separated by spaces. Extra spacing and capitals do not matter.
            </p>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="recover-password">
              New password
            </label>
            <input
              id="recover-password"
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
            <label className={styles.label} htmlFor="recover-confirm">
              Confirm new password
            </label>
            <input
              id="recover-confirm"
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
              Set my new password
            </button>
          )}
        </div>
      )}

      <p className={styles.switch}>
        <Link href="/sign-in">Back to sign in</Link>
      </p>
    </form>
  )
}

const LEDE: Record<Screen, string> = {
  checking: 'One moment.',
  request:
    'We will email you a link. Your recovery phrase alone is enough to open your calendar, but we have to know the link reached your inbox before handing over anything to unlock.',
  sent: 'If that address has a CloakCal account, a sign-in link is on its way. Open it on this device, then enter your recovery phrase.',
  reset:
    'Your recovery phrase opens your key here in the browser. Your events are not re-encrypted and nothing about them changes — only the password that unlocks them.',
}

function messageFor(caught: unknown): string {
  if (caught instanceof WrongRecoveryPhraseError) return caught.message
  // Half-applied carries a specific instruction, and the instruction is the useful part.
  // Flattening it into "something went wrong" would strand the user mid-change.
  if (caught instanceof RewrapHalfAppliedError) return caught.message
  if (caught instanceof Error) {
    if (/checksum|word|entropy|mnemonic/i.test(caught.message)) {
      return 'That does not look like a complete 24-word phrase. Check for a missing or mistyped word.'
    }
    return caught.message
  }
  return String(caught)
}
