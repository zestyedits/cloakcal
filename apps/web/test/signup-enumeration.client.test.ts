import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Signing up must not reveal whether an address already has an account.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SOURCE-LEVEL TEST, WHICH IS UNUSUAL AND DELIBERATE
 * ---------------------------------------------------------------------------
 *
 * The leak this guards against cannot be observed from the outside once it exists — the
 * whole point of account enumeration is that the disclosure LOOKS like helpful copy. A
 * behavioural test would have to assert the absence of a distinction that a future version
 * might draw in wording we cannot predict ("welcome back", "that's you already", a different
 * heading). So this reads the source and forbids the specific mechanism instead.
 *
 * The mechanism is narrow and documented: Supabase's `signUp` returns success for an address
 * that already has a confirmed account, and the only tell is `data.user.identities` coming
 * back as an empty array. Any code path that inspects `identities` in the sign-up flow is
 * either building this leak or one refactor away from it.
 *
 * ---------------------------------------------------------------------------
 * WHY IT MATTERS MORE HERE THAN IN AN ORDINARY APP
 * ---------------------------------------------------------------------------
 *
 * CloakCal encrypts what your meetings are called. A signup form that confirms an address is
 * registered hands over something the encryption never protected and cannot: that a
 * particular person uses a privacy calendar at all. For a lot of the people this product is
 * for, that fact is the sensitive one.
 *
 * It is also free to exploit — no rate limit defeats a single query against an address
 * someone already suspects.
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

const AUTH_FORM = read('../src/components/auth-form.tsx')
const CLOAK_SESSION = read('../src/lib/cloak-session.ts')

/** Strip comments, so the explanation of the rule does not trip the rule. */
const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

describe('the sign-up flow cannot tell an existing account from a new one', () => {
  it('never inspects `identities`, the one field that gives it away', () => {
    expect(code(AUTH_FORM)).not.toMatch(/identities/)
    expect(code(CLOAK_SESSION)).not.toMatch(/identities/)
  })

  it('returns only whether confirmation is pending, and nothing about the account', () => {
    // `signUp`'s return type is the whole API surface between the auth call and the UI. If a
    // future change wants to say "you already have an account", it has to widen this — which
    // is the moment to stop and read the comment above, not a detail to slip past review.
    const signature = /export async function signUp\([^)]*\): Promise<\{ needsConfirmation: boolean \}>/
    expect(CLOAK_SESSION).toMatch(signature)
  })

  it('does not claim an email was sent, because sometimes none is', () => {
    // The old copy read "We sent a confirmation link to {email}". For an address that already
    // had an account that was simply untrue, and it left the user waiting for mail that was
    // never coming with no way to distinguish that from a delivery failure. Found by hitting
    // it in production.
    // Comments stripped: the note above quotes the old wording, and the rule should not
    // fire on its own explanation.
    expect(code(AUTH_FORM)).not.toMatch(/We sent a confirmation link/)
  })

  it('offers both ways out, since it will not say which one is needed', () => {
    // Withholding the answer is only acceptable if the user can act without it. The screen
    // has to carry sign-in AND password reset, or "we won't tell you" becomes a dead end.
    const confirmScreen = AUTH_FORM.slice(
      AUTH_FORM.indexOf("stage.kind === 'confirm-email'"),
      AUTH_FORM.indexOf('return (\n    <form'),
    )
    expect(confirmScreen).toMatch(/href="\/sign-in"/)
    expect(confirmScreen).toMatch(/href="\/recover"/)
  })
})
