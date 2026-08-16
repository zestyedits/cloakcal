'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  CloakSetupRequiredError,
  WrapEmailMismatchError,
  initializeCloak,
  signInAndUnlock,
  signUp,
} from '@/lib/cloak-session'
import { assessPassword } from '@cloakcal/crypto'
import { supabaseBrowser } from '@/lib/supabase/client'
import { signupsOpen } from '@/lib/signups'
import { RecoveryPhrase } from './recovery-phrase'
import { CloakHomeLink } from './cloak-logo'
import { InlineError } from './ui/inline-error'
import { Button, ButtonLink } from './ui/button'
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

/**
 * Slugs from /auth/callback, turned into something a person can act on.
 *
 * The route deliberately does not forward Supabase's own message: its verifier failure is a
 * paragraph of advice about using @supabase/ssr, addressed to a developer. Matching on a slug
 * rather than prose is the same rule the RPC errors follow.
 */
const AUTH_FAILURES: Record<string, string> = {
  link_dead:
    'That link has expired or was already used. Links are single-use and short-lived on ' +
    'purpose. Sign in below, or sign up again to get a new one.',
  wrong_browser:
    'That link has to be opened in the same browser it was sent from. Open your email on ' +
    'this device, or sign up again from here and use the new link.',
}

export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [stage, setStage] = useState<Stage>({ kind: 'form' })
  const [error, setError] = useState<string | null>(null)

  const busy = stage.kind === 'working'

  /**
   * A dead confirmation link says so, here.
   *
   * /auth/callback cannot render anything — it is a Route Handler whose only move is a
   * redirect — so it hands the reason over in the query string. Without this the user clicks
   * "Confirm email", lands on a sign-in form, and has no way to tell an expired link from a
   * link that worked, which is precisely the confusion that made this bug hard to report.
   */
  const params = useSearchParams()
  const authError = params.get('authError')
  useEffect(() => {
    if (authError !== null && authError !== '') setError(AUTH_FAILURES[authError] ?? AUTH_FAILURES['link_dead']!)
  }, [authError])

  // Recomputed each render rather than memoised: it is a handful of string scans, and a
  // stale meter is worse than a fast one.
  const strength = assessPassword(password, email)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)

    try {
      if (mode === 'sign-up') {
        // Checked here, not only on the input. `minLength` is a hint to the browser and
        // nothing else: devtools removes it, and any other caller of signUp never saw it.
        // This password derives the key that decrypts the content, so it is not a lock on the
        // box — it is how strong the box is.
        const strength = assessPassword(password, email)
        if (!strength.acceptable) {
          setError(strength.problems.join(' '))
          return
        }
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
        <h1 className={styles.title}>Check your inbox</h1>
        {/*
          THIS SCREEN MUST NOT SAY WHETHER THE ADDRESS IS ALREADY REGISTERED, and it also must
          not claim an email was definitely sent.

          Signing up with an address that already has an account returns success and sends
          NOTHING. That is Supabase behaving correctly: a form that answered "that address is
          taken" would be a free tool for discovering who uses CloakCal — account enumeration
          — and for a privacy product that is a worse leak than most of what the app encrypts.

          The old copy here read "We sent a confirmation link to {email}", which is a claim
          this page cannot make. Someone who already had an account was told to wait for mail
          that was never coming, with no way to tell that from a delivery failure. That is how
          this was found.

          So the copy covers both cases without resolving which, and — the part that actually
          matters — hands over the two escape routes either way.

          DO NOT "improve" this by branching on `data.user.identities.length === 0`, which is
          the documented tell for an existing account. It would reintroduce the leak in
          client-side code, where it is easiest to miss and easiest to script against.
        */}
        <p className={styles.lede}>
          If <strong>{email}</strong> is new here, a confirmation link is on its way. Open it,
          then sign in. Your keys are created on your device, at first sign-in.
        </p>
        <p className={styles.lede}>
          <strong>Nothing arrives?</strong> You may already have an account. This page will not
          say which, deliberately: if it did, anyone could use it to find out who has a CloakCal
          account. Try signing in, or reset your password.
        </p>
        {/* ButtonLink, which is what the inline textAlign/lineHeight/textDecoration
            overrides here were reimplementing badly: a 44px line-height is not a 44px
            target, and it broke the moment the label wrapped. */}
        <ButtonLink href="/sign-in" className={styles.fullWidth}>
          Go to sign in
        </ButtonLink>
        <p className={styles.hint} style={{ textAlign: 'center' }}>
          <Link href="/recover">Reset your password</Link>
        </p>
      </div>
    )
  }

  return (
    <form className={styles.card} onSubmit={submit}>
      <CloakHomeLink />

      <h1 className={styles.title}>
        {mode === 'sign-up' ? 'Create your calendar' : 'Welcome back'}
      </h1>
      <p className={styles.lede}>
        {mode === 'sign-up'
          ? 'Your password never leaves this device. It becomes the key that opens your events, and we only ever receive something derived from it that cannot open anything.'
          : 'Your password unlocks your events here in the browser. We never receive it.'}
      </p>

      <InlineError>{error}</InlineError>

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
            minLength={mode === 'sign-up' ? 12 : 1}
            autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
            disabled={busy}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-describedby={mode === 'sign-up' ? 'password-strength' : undefined}
          />
          {/* Sign-IN has no floor, deliberately. Anyone who set a shorter password before
              this existed must still be able to get in; refusing them at the door would be
              locking people out of their own calendars to enforce a rule added later. */}
          {mode === 'sign-up' && (
            <p id="password-strength" className={styles.hint} aria-live="polite">
              {password === ''
                ? 'Twelve characters or more. A few unrelated words beats one mangled one.'
                : strength.problems.length > 0
                  ? strength.problems.join(' ')
                  : `Looks ${strength.verdict}.`}
            </p>
          )}
        </div>

        {busy ? (
          <p className={styles.working} aria-live="polite">
            <span className={styles.pulse} aria-hidden="true" />
            {stage.label}. This takes a moment on purpose. A slow derivation is what makes a
            stolen database expensive to attack.
          </p>
        ) : (
          <Button type="submit" className={styles.fullWidth}>
            {mode === 'sign-up' ? 'Create account' : 'Sign in'}
          </Button>
        )}
      </div>

      <p className={styles.switch}>
        {mode === 'sign-up' ? (
          <>
            Already have an account? <Link href="/sign-in">Sign in</Link>
          </>
        ) : (
          <>
            {/* While sign-ups are closed the invitation goes with them. Sending someone to
                a page that can only turn them away is a worse answer than saying so here. */}
            {signupsOpen() ? (
              <>
                No account yet? <Link href="/sign-up">Create one</Link>
              </>
            ) : (
              'New accounts are not open yet.'
            )}
            {/* Until this existed, the 24-word phrase we make people write down at signup
                had nowhere to be typed unless they were already signed in — which is the
                one situation where they do not need it. */}
            <br />
            <Link href="/recover">Forgot your password?</Link>
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
  // Named BEFORE the regex ladder below. Those patterns match on message text, which is
  // fine for Supabase's strings and wrong for ours: a typed error that already says the
  // right thing should never be at the mercy of a substring match it did not anticipate.
  if (caught instanceof WrapEmailMismatchError) return caught.message

  const message = caught instanceof Error ? caught.message : String(caught)

  if (/invalid login credentials/iu.test(message)) {
    return 'That email and password combination did not work.'
  }
  if (/password/iu.test(message) && /length|characters|short/iu.test(message)) {
    return 'Choose a longer password, at least 10 characters.'
  }
  if (/already registered|already exists/iu.test(message)) {
    return 'There is already an account with that email. Try signing in.'
  }
  return message
}
