/**
 * Whether new accounts can be created.
 *
 * FAIL-CLOSED ON PURPOSE: an unset variable means closed. The two failure modes are not
 * symmetric. Forgetting to set this in production would leave the door open to strangers
 * silently, which is the exact thing the flag exists to prevent; forgetting it locally
 * breaks a sign-up you were deliberately attempting and says so on screen. A gate that
 * defaults open is a gate that reports green while standing aside.
 *
 * `NEXT_PUBLIC_` so the sign-in form can drop its now-dead "create one" link in the same
 * render. Next inlines it at build time, so opening sign-ups is a redeploy rather than a
 * runtime toggle — deliberate, because the same is true of every other public flag here
 * and a half-open door is worse than either state.
 *
 * NOT the dev flag. `NEXT_PUBLIC_CLOAKCAL_DEV_UNLOCK` governs three things that must move
 * together and every one of them also checks `NODE_ENV !== 'production'`, so it cannot
 * express "closed in production" at all. This is a fourth, independent question.
 *
 * **This is the door, not the wall.** It stops people, not scripts: the browser talks to
 * Supabase directly, so a determined caller can still reach the sign-up endpoint. Supabase
 * Auth's own "Allow new users to sign up" is the enforcement. Flip this alongside it,
 * never instead of it.
 */
export function signupsOpen(): boolean {
  return process.env.NEXT_PUBLIC_CLOAKCAL_SIGNUPS_OPEN === '1'
}
