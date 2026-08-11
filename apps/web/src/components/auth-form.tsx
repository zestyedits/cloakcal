'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  CloakSetupRequiredError,
  initializeCloak,
  signInAndUnlock,
  signUp,
} from '@/lib/cloak-session'
import { supabaseBrowser } from '@/lib/supabase/client'
import { RecoveryPhrase } from './recovery-phrase'
import styles from './auth.module.css'

/**
 * Sign in and sign up.
 *
 * The password is used here and nowhere else. It is turned into a master secret in the
 * browser, split into an auth secret (which goes to Supabase) and a wrapping key (which does
 * not), and then dropped. See ADR 0002 amendment 1 for why sending the password itself would
 * quietly undo the whole design.
 *
 * The visible cost is that Argon2id takes about a second. That wait is named rather than
 * disguised: an unexplained frozen button reads as a broken app, and "deriving your key"
 * happens to be the truth.
 */

type Mode = 'sign-in' | 'sign-up'
type Stage =
  | { kind: 'form' }
  | { kind: 'working'; label: string }
  | { kind: 'confirm-email' }
  | { kind: 'recovery'; phrase: string }

export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [stage, setStage] = useState<Stage>({ kind: 'form' })
  const [error, setError] = useState<string | null>(null)

  const busy = stage.kind === 'working'

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)

    try {
      if (mode === 'sign-up') {
        setStage({ kind: 'working', label: 'Creating your account' })
        const { needsConfirmation } = await signUp(email, password)
        if (needsConfirmation) {
          setStage({ kind: 'confirm-email' })
          return
        }
        // Confirmation is off, so there is a session already: go straight to setup.
        await runSetup()
        return
      }

      setStage({ kind: 'working', label: 'Deriving your key' })
      await signInAndUnlock(email, password)
      router.replace('/')
      router.refresh()
    } catch (caught) {
      if (caught instanceof CloakSetupRequiredError) {
        await runSetup()
        return
      }
      setStage({ kind: 'form' })
      setError(messageFor(caught))
    }
  }

  const runSetup = async () => {
    setStage({ kind: 'working', label: 'Generating your keys' })
    try {
      const { recoveryPhrase } = await initializeCloak(email, password)
      setStage({ kind: 'recovery', phrase: recoveryPhrase })
    } catch (caught) {
      setStage({ kind: 'form' })
      setError(messageFor(caught))
    }
  }

  const finish = async () => {
    // Recorded only after the user proved they can reproduce the phrase. An account marked
    // confirmed on the strength of a checkbox is an account we would wrongly stop nagging.
    const supabase = supabaseBrowser()
    const { data } = await supabase.auth.getUser()
    if (data.user !== null) {
      await supabase
        .from('profiles')
        .update({ recovery_phrase_confirmed_at: new Date().toISOString() })
        .eq('id', data.user.id)
    }
    router.replace('/')
    router.refresh()
  }

  if (stage.kind === 'recovery') {
    return <RecoveryPhrase phrase={stage.phrase} onConfirmed={() => void finish()} />
  }

  if (stage.kind === 'confirm-email') {
    return (
      <div className={styles.card}>
        <h1 className={styles.title}>Check your email</h1>
        <p className={styles.lede}>
          We sent a confirmation link to {email}. Open it, then sign in — your keys are generated on
          your first sign-in, on your device.
        </p>
        <Link href="/sign-in" className={styles.submit} style={{ textAlign: 'center', lineHeight: '44px', textDecoration: 'none' }}>
          Go to sign in
        </Link>
      </div>
    )
  }

  return (
    <form className={styles.card} onSubmit={submit}>
      <div className={styles.brand}>
        <span className={styles.mark} aria-hidden="true" />
        <span className={styles.wordmark}>
          Cloak<span className={styles.wordmarkAccent}>Cal</span>
        </span>
      </div>

      <h1 className={styles.title}>
        {mode === 'sign-up' ? 'Create your calendar' : 'Welcome back'}
      </h1>
      <p className={styles.lede}>
        {mode === 'sign-up'
          ? 'Your password never leaves this device. It becomes the key that opens your events, and we only ever receive something derived from it that cannot open anything.'
          : 'Your password unlocks your events here in the browser. We never receive it.'}
      </p>

      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <div className={styles.form}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="email">
            Email
          </label>
          <input
            id="email"
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

        <div className={styles.field}>
          <label className={styles.label} htmlFor="password">
            Password
          </label>
          <input
            id="password"
            className={styles.input}
            type="password"
            required
            minLength={10}
            autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
            disabled={busy}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {busy ? (
          <p className={styles.working} aria-live="polite">
            <span className={styles.pulse} aria-hidden="true" />
            {stage.label}. This takes a moment on purpose — a slow derivation is what makes a
            stolen database expensive to attack.
          </p>
        ) : (
          <button type="submit" className={styles.submit}>
            {mode === 'sign-up' ? 'Create account' : 'Sign in'}
          </button>
        )}
      </div>

      <p className={styles.switch}>
        {mode === 'sign-up' ? (
          <>
            Already have an account? <Link href="/sign-in">Sign in</Link>
          </>
        ) : (
          <>
            No account yet? <Link href="/sign-up">Create one</Link>
          </>
        )}
      </p>
    </form>
  )
}

/**
 * Supabase's own messages are usually the clearest thing available, but two are worth
 * replacing: the generic invalid-credentials string, and anything mentioning a password
 * length, since the value Supabase sees is our 64-character auth secret and a complaint
 * about *its* length would be nonsense to the user.
 */
function messageFor(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : String(caught)

  if (/invalid login credentials/iu.test(message)) {
    return 'That email and password combination did not work.'
  }
  if (/password/iu.test(message) && /length|characters|short/iu.test(message)) {
    return 'Choose a longer password — at least 10 characters.'
  }
  if (/already registered|already exists/iu.test(message)) {
    return 'There is already an account with that email. Try signing in.'
  }
  return message
}
