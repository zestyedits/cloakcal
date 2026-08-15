'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  RewrapHalfAppliedError,
  WrongRecoveryPhraseError,
  rewrapPasswordWrap,
  persistUnlockedSession,
  rootKeyFromRecoveryPhrase,
} from '@/lib/cloak-session'
import { supabaseBrowser } from '@/lib/supabase/client'
import { CloakHomeLink } from './cloak-logo'
import { RecoveryPhraseInput } from './recovery-phrase-input'
import { InlineError } from './ui/inline-error'
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

  /**
   * Work out whether the visitor arrived from a recovery link, and say so when they did but
   * it did not work.
   *
   * THE LINK COMES BACK AS `?code=`, NOT A FRAGMENT. An earlier version of this comment said
   * the token arrives in the URL hash. That is the IMPLICIT flow; `@supabase/ssr`'s
   * `createBrowserClient` hardcodes `flowType: 'pkce'`, so GoTrue redirects here with an
   * authorisation code in the query string which supabase-js exchanges for a session.
   *
   * PKCE has a consequence that WILL happen to real people: the exchange needs a
   * `code_verifier` that was stored in this browser when the reset was requested. Request the
   * link on a laptop, open it on a phone, and the code is worthless — which is the whole
   * point of PKCE, and is more secure than the alternative, but it is not nothing to the
   * person holding the phone.
   *
   * Until now that failed SILENTLY. No session appeared, so the screen fell back to "enter
   * your email", and the user concluded the link was broken and requested another one, which
   * would fail the same way forever. A dead end that looks like a working form is worse than
   * an error.
   *
   * So a code in the URL is treated as a promise: if it does not produce a session, say why.
   */
  useEffect(() => {
    const supabase = supabaseBrowser()
    let cancelled = false

    const url = new URL(globalThis.location.href)
    const hasCode = url.searchParams.has('code')
    // GoTrue reports an unusable link in the FRAGMENT, even under PKCE — an expired or
    // already-used token never becomes a code, so it never reaches the query string.
    const hash = new URLSearchParams(url.hash.replace(/^#/, ''))
    const linkError = hash.get('error_description') ?? hash.get('error')

    void supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return
      if (data.session !== null) {
        setScreen('reset')
        return
      }
      if (linkError !== null) {
        setError(
          'That link has expired or was already used. Request a new one below. They are ' +
            'single-use and short-lived on purpose.',
        )
      } else if (hasCode) {
        // Only reachable when the exchange failed, which in practice means a different
        // browser or cleared storage.
        setError(
          'This link has to be opened in the same browser that asked for it, on the same ' +
            'device. Request a new one here and open it from this browser.',
        )
      }
      setScreen('request')
    })

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (cancelled || session === null) return
      // Only ever moves forward. Sending a half-filled reset form back to the email step
      // because a token refreshed would discard a phrase the user just typed.
      setScreen('reset')
      setError(null)
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

      // UNLOCK BEFORE NAVIGATING. This step was missing, and the comment that stood here
      // claimed the opposite — "the key is already open" — which it was not:
      // rootKeyFromRecoveryPhrase only unwraps, and nothing on this path had ever written
      // the session to the vault. So the user finished recovery and was dropped straight
      // onto the unlock panel, having just typed 24 words and chosen a password. The worst
      // moment in the product to ask someone to authenticate again.
      await persistUnlockedSession(address, rootKey)

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
      <CloakHomeLink />

      <h1 className={styles.title}>{screen === 'sent' ? 'Check your email' : 'Get back in'}</h1>
      <p className={styles.lede}>{LEDE[screen]}</p>

      <InlineError>{error}</InlineError>

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
            <RecoveryPhraseInput
              label="Your 24-word recovery phrase"
              value={phrase}
              disabled={busy}
              onChange={setPhrase}
            />
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
              {working}. This takes a moment on purpose. A slow derivation is what makes a
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
    'Your recovery phrase opens your key here in the browser. Your events are not re-encrypted and nothing about them changes. Only the password that unlocks them does.',
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
