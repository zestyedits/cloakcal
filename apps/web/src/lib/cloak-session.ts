'use client'

import {
  CURRENT_KDF_PARAMS,
  cloakField,
  createRootKey,
  deriveAuthSecret,
  deriveMasterSecret,
  deriveRecoveryWrapKey,
  deriveWrapKey,
  generateRecoveryPhrase,
  normalizeAccountEmail,
  unwrapRootKey,
  wrapRootKey,
  type CloakedPayload,
  type KdfParams,
  type RootKey,
} from '@cloakcal/crypto'
import { forgetAllSessionKeys, recallSessionKey, rememberSessionKey } from '@cloakcal/cloak-store'
import type { SessionKey } from '@cloakcal/crypto'
import { supabaseBrowser } from './supabase/client'
import { fromPgBytea, toPgBytea } from './pg-bytes'

/**
 * Authentication and unlock, in the browser, in that order.
 *
 * THE SHAPE OF THIS FILE IS THE SECURITY PROPERTY. Every function here is client-only
 * ('use client', and the crypto package cannot be imported from a server module at all).
 * The password never leaves this file; what leaves is an auth secret that cannot open
 * anything, and wrapped bytes the server cannot unwrap. See ADR 0002 amendment 1.
 *
 * TWO SEPARATE GATES. Signing in proves who you are to Postgres, which is what RLS acts on.
 * Unlocking proves you hold the root key, which is what makes content readable. They can
 * fail independently and mean different things: a signed-in user with no key sees their
 * calendar's shape — times, durations, recurrence — and no content at all. That is not a
 * broken state, it is Tier A working exactly as D1 describes.
 */

export interface CloakSession {
  readonly userId: string
  readonly email: string
  /** Non-extractable. Present only once the account is unlocked. */
  readonly sessionKey: SessionKey
}

export class CloakSetupRequiredError extends Error {
  constructor() {
    super('This account has no root key yet. Run Cloak setup before unlocking.')
    this.name = 'CloakSetupRequiredError'
  }
}

export class WrongPasswordError extends Error {
  constructor() {
    super('That password did not open your calendar.')
    this.name = 'WrongPasswordError'
  }
}

export class WrongRecoveryPhraseError extends Error {
  constructor() {
    super('That recovery phrase did not open your calendar. Check for a mistyped word.')
    this.name = 'WrongRecoveryPhraseError'
  }
}

/** The new wrap failed its own round-trip check, so nothing was written. */
export class RewrapVerificationError extends Error {
  constructor() {
    super('Your password was not changed. Nothing was altered, so your old one still works.')
    this.name = 'RewrapVerificationError'
  }
}

/**
 * The new wrap was stored but the account password was not updated.
 *
 * The honest and useful thing to say, because the user can act on it: their OLD password
 * still signs them in, but it will no longer open their calendar, and retrying the change
 * fixes it. The recovery phrase works throughout. This is the deliberately-chosen half of
 * the two possible failures — see rewrapPasswordWrap.
 */
export class RewrapHalfAppliedError extends Error {
  constructor() {
    super(
      'Your calendar key was updated but the new password did not save. Sign in with your ' +
        'OLD password and try again. Your events are safe, and your recovery phrase still works.',
    )
    this.name = 'RewrapHalfAppliedError'
  }
}

interface StoredWrap {
  kind: string
  kdf: KdfParams | null
  wrapped: string
  nonce: string
  alg: string
}

/**
 * Sign up.
 *
 * Supabase receives the derived auth secret, never the password. Cloak setup is deliberately
 * NOT bolted on here: if the project requires email confirmation there is no session yet,
 * and generating a root key we cannot store would strand it. Setup runs on first successful
 * sign-in instead, where a session is guaranteed.
 */
export async function signUp(email: string, password: string): Promise<{ needsConfirmation: boolean }> {
  const supabase = supabaseBrowser()
  const master = await deriveMasterSecret(password, email, CURRENT_KDF_PARAMS)
  const authSecret = await deriveAuthSecret(master)

  // WHERE THE CONFIRMATION LINK LANDS, and it has to be said explicitly.
  //
  // Without this, Supabase uses its Site URL — `/` — which is not a public path. Middleware
  // runs on the server before any JavaScript, sees no session cookie (there cannot be one
  // yet; the code in the URL is what would create it) and redirects to /sign-in. The user
  // sees "confirm does nothing", and the token is single-use so the link cannot be retried.
  const { data, error } = await supabase.auth.signUp({
    email,
    password: authSecret,
    options: { emailRedirectTo: `${globalThis.location.origin}/auth/callback` },
  })
  if (error !== null) throw error

  return { needsConfirmation: data.session === null }
}

/**
 * Sign in and unlock in one pass, because both need the same expensive derivation and
 * asking for the password twice would be indefensible.
 *
 * Throws CloakSetupRequiredError when the account authenticates but has no wrap yet — the
 * caller runs the setup ceremony and must pass the same password back in.
 */
export async function signInAndUnlock(email: string, password: string): Promise<CloakSession> {
  const supabase = supabaseBrowser()

  const master = await deriveMasterSecret(password, email, CURRENT_KDF_PARAMS)
  const authSecret = await deriveAuthSecret(master)

  const { data, error } = await supabase.auth.signInWithPassword({ email, password: authSecret })
  if (error !== null) throw error
  const userId = data.user.id

  const { data: wrap, error: wrapError } = await supabase
    .from('root_key_wraps')
    .select('kind, kdf, wrapped, nonce, alg')
    .eq('kind', 'password')
    .maybeSingle<StoredWrap>()
  if (wrapError !== null) throw wrapError
  if (wrap === null) throw new CloakSetupRequiredError()

  // Parameters arrive from the server so they can be raised over time; deriveMasterSecret
  // refuses anything below the client floor, so this can only ever cost more, never less.
  const stored = wrap.kdf ?? CURRENT_KDF_PARAMS
  const rootKey = await unwrapWithPassword(password, email, stored, wrap)

  return finishUnlock(userId, email, rootKey)
}

async function unwrapWithPassword(
  password: string,
  email: string,
  params: KdfParams,
  wrap: StoredWrap,
): Promise<RootKey> {
  const master = await deriveMasterSecret(password, email, params)
  const wrapKey = await deriveWrapKey(master)

  try {
    return await unwrapRootKey(
      {
        kind: 'password',
        wrapped: fromPgBytea(wrap.wrapped),
        nonce: fromPgBytea(wrap.nonce),
        alg: 'aes-256-gcm-v1',
      },
      wrapKey,
    )
  } catch {
    // Authentication already succeeded, so the password was right for the account. Reaching
    // here means the wrap does not match it — a rewrap that half-completed, or a restored
    // backup. Saying "wrong password" is the truthful summary for the user; the distinction
    // matters to us, not to them.
    throw new WrongPasswordError()
  }
}

/**
 * First-run ceremony. Generates the root key, wraps it under both the password and a fresh
 * recovery phrase, and creates the first workspace and calendar.
 *
 * The phrase is RETURNED, not stored. It exists in memory long enough to be shown once and
 * confirmed, and there is no second copy anywhere — including here.
 */
export async function initializeCloak(
  email: string,
  password: string,
): Promise<{ session: CloakSession; recoveryPhrase: string }> {
  const supabase = supabaseBrowser()
  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError !== null) throw userError
  const userId = userData.user.id

  const rootKey = createRootKey()
  const recoveryPhrase = generateRecoveryPhrase()

  const master = await deriveMasterSecret(password, email, CURRENT_KDF_PARAMS)
  const passwordWrap = await wrapRootKey(rootKey, await deriveWrapKey(master), 'password')
  const recoveryWrap = await wrapRootKey(
    rootKey,
    await deriveRecoveryWrapKey(recoveryPhrase),
    'recovery',
  )

  // Both wraps in one statement. A password wrap without a recovery wrap is an account one
  // forgotten password away from unrecoverable, and that window should not exist even for
  // the length of a second round trip.
  const { error: wrapError } = await supabase.from('root_key_wraps').insert([
    {
      user_id: userId,
      kind: 'password',
      kdf: CURRENT_KDF_PARAMS,
      wrapped: toPgBytea(passwordWrap.wrapped),
      nonce: toPgBytea(passwordWrap.nonce),
      alg: passwordWrap.alg,
    },
    {
      user_id: userId,
      kind: 'recovery',
      wrapped: toPgBytea(recoveryWrap.wrapped),
      nonce: toPgBytea(recoveryWrap.nonce),
      alg: recoveryWrap.alg,
    },
  ])
  if (wrapError !== null) throw wrapError

  await bootstrapWorkspace(userId, rootKey)

  return { session: await finishUnlock(userId, email, rootKey), recoveryPhrase }
}

/** Load one of this user's wraps. Requires a session — RLS keys the row to auth.uid(). */
async function loadWrap(kind: 'password' | 'recovery'): Promise<StoredWrap> {
  const { data, error } = await supabaseBrowser()
    .from('root_key_wraps')
    .select('kind, kdf, wrapped, nonce, alg')
    .eq('kind', kind)
    .maybeSingle<StoredWrap>()
  if (error !== null) throw error
  if (data === null) throw new CloakSetupRequiredError()
  return data
}

/** Open the root key with the recovery phrase. Does not unlock a session on its own. */
export async function rootKeyFromRecoveryPhrase(phrase: string): Promise<RootKey> {
  const wrap = await loadWrap('recovery')
  try {
    return await unwrapRootKey(
      {
        kind: 'recovery',
        wrapped: fromPgBytea(wrap.wrapped),
        nonce: fromPgBytea(wrap.nonce),
        alg: 'aes-256-gcm-v1',
      },
      await deriveRecoveryWrapKey(phrase),
    )
  } catch {
    throw new WrongRecoveryPhraseError()
  }
}

/**
 * Open the root key with the account password, for an ALREADY SIGNED-IN user.
 *
 * Separate from signInAndUnlock because changing your password must not depend on being
 * able to sign in again first — and because a resumed session cannot do this at all: the
 * key persisted at last unlock is non-extractable by design, and rewrapping needs the raw
 * bytes. That is why the account page asks for something you know rather than reusing the
 * session you already have.
 */
export async function rootKeyFromPassword(email: string, password: string): Promise<RootKey> {
  const wrap = await loadWrap('password')
  return unwrapWithPassword(password, email, wrap.kdf ?? CURRENT_KDF_PARAMS, wrap)
}

/** Recovery path: the phrase opens the key, then the user sets a new password. */
export async function unlockWithRecoveryPhrase(
  email: string,
  phrase: string,
): Promise<CloakSession> {
  const supabase = supabaseBrowser()
  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError !== null) throw userError

  const rootKey = await rootKeyFromRecoveryPhrase(phrase)
  return finishUnlock(userData.user.id, email, rootKey)
}

/**
 * Re-wrap the root key under a new password, and set that password on the account.
 *
 * THE ROOT KEY DOES NOT CHANGE. Only the wrapper around it does, so nothing is re-encrypted:
 * every event, every calendar name, every field key still derives from the same URK. A user
 * changing their password should not have to wait for their calendar to be rewritten, and a
 * design that required it would make rotation something people avoid.
 *
 * THE ORDER OF THE LAST TWO STEPS IS THE SAFETY ARGUMENT. Postgres and GoTrue are two
 * systems with no shared transaction, so one of them can succeed while the other fails and
 * there is no way to make that window vanish. There is a choice about WHICH half-state you
 * get left in:
 *
 *   wrap first, then auth  → if auth fails, the OLD password still signs you in. You are
 *                            stuck at unlock, the recovery phrase still works, and you can
 *                            simply try again. Recoverable with what the user already has.
 *   auth first, then wrap  → if the wrap fails, the old password is already gone. You can
 *                            sign in with the new one, but nothing opens your calendar
 *                            except the phrase.
 *
 * So the wrap is written first. The irreversible step goes last, which is the general rule
 * this happens to be an instance of.
 *
 * The recovery and device wraps are untouched — they wrap the same unchanged URK — so the
 * phrase keeps working across any number of password changes.
 */
export async function rewrapPasswordWrap(
  rootKey: RootKey,
  email: string,
  newPassword: string,
): Promise<void> {
  const supabase = supabaseBrowser()
  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError !== null) throw userError

  const master = await deriveMasterSecret(newPassword, email, CURRENT_KDF_PARAMS)
  const authSecret = await deriveAuthSecret(master)
  const wrapKey = await deriveWrapKey(master)
  const wrapped = await wrapRootKey(rootKey, wrapKey, 'password')

  // Open it again, here, before anything is written.
  //
  // Cheap — one AES-GCM decrypt against a key already in hand — and it is the difference
  // between a bug that fails now and a bug that fails the next time this person tries to
  // sign in, by which point the old wrap is gone and the only way back is the phrase. A
  // wrap that cannot be opened must never reach the database.
  // Both failure shapes mean the same thing to the user — nothing was written, the old
  // password still works — so both become RewrapVerificationError. Letting the raw
  // RootKeyUnwrapError through would put "wrong key, tampered data, or a wrap made for a
  // different purpose" in front of someone who only tried to change their password.
  let verified = false
  try {
    const check = await unwrapRootKey(wrapped, wrapKey)
    verified = sameBytes(check.bytes, rootKey.bytes)
  } catch {
    verified = false
  }
  if (!verified) throw new RewrapVerificationError()

  const { data: updated, error: updateError } = await supabase
    .from('root_key_wraps')
    .update({
      // The email is the KDF salt, so which address derived this wrap is part of how to
      // open it. Recorded so a later mismatch can say "set up under a different email"
      // rather than "wrong password". See the salt note in CLAUDE.md.
      kdf: { ...CURRENT_KDF_PARAMS, saltEmail: normalizeAccountEmail(email) },
      wrapped: toPgBytea(wrapped.wrapped),
      nonce: toPgBytea(wrapped.nonce),
      alg: wrapped.alg,
    })
    .eq('user_id', userData.user.id)
    .eq('kind', 'password')
    .select('id')
  if (updateError !== null) throw updateError

  // A silent zero-row update is the dangerous outcome: the auth change below would then
  // land against a wrap keyed to the old password, which is precisely the lockout this
  // whole function exists to prevent. RLS returns no rows rather than an error when the
  // row is not yours, so "no error" is not the same as "it worked".
  if (updated === null || updated.length !== 1) {
    throw new RewrapVerificationError()
  }

  const { error: authError } = await supabase.auth.updateUser({ password: authSecret })
  if (authError !== null) throw new RewrapHalfAppliedError()
}

/**
 * Issue a NEW recovery phrase, replacing the old one.
 *
 * ---------------------------------------------------------------------------
 * THE TRAP THIS CLOSES
 * ---------------------------------------------------------------------------
 *
 * The phrase is shown exactly once and there is no second copy anywhere, which is correct —
 * a phrase we could re-show would be a phrase we had stored. But until now there was also no
 * way to get a DIFFERENT one. Lose the paper while still signed in and the account is already
 * unrecoverable; you just do not find out until the next time you need it. One logout, or one
 * cleared browser, and the events are gone.
 *
 * That is a strictly worse position than a user who never wrote it down, because it looks
 * fine. Rotation costs nothing in security: it needs the root key, so the caller has already
 * proved they can open the account. Someone who can rotate the phrase could read every event
 * anyway.
 *
 * ---------------------------------------------------------------------------
 * WHY IT TAKES A RootKey RATHER THAN JUST WORKING
 * ---------------------------------------------------------------------------
 *
 * A resumed session holds a NON-EXTRACTABLE key (see key-vault.ts) — usable for decryption,
 * impossible to wrap, because wrapping needs the raw bytes. So the caller has to re-derive
 * from the password or the current phrase. That is not a workaround: re-authenticating before
 * issuing new recovery material is the right shape. Otherwise an unlocked laptop left open is
 * enough for someone to mint themselves a permanent way back in.
 *
 * The root key itself does not change, so nothing is re-encrypted, the password and device
 * wraps are untouched, and an unlocked session stays unlocked. Only the recovery wrap moves.
 */
export async function reissueRecoveryPhrase(rootKey: RootKey): Promise<string> {
  const supabase = supabaseBrowser()
  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError !== null) throw userError

  const phrase = generateRecoveryPhrase()
  const wrapped = await wrapRootKey(rootKey, await deriveRecoveryWrapKey(phrase), 'recovery')

  // Opened again before anything is written, exactly as in rewrapPasswordWrap and for a
  // sharper reason: this row IS the last resort. A recovery wrap that cannot be opened
  // replaces a working way back with a broken one, and nothing would notice until someone
  // needed it — the single worst moment to discover a bug.
  let verified = false
  try {
    const check = await unwrapRootKey(wrapped, await deriveRecoveryWrapKey(phrase))
    verified = sameBytes(check.bytes, rootKey.bytes)
  } catch {
    verified = false
  }
  if (!verified) throw new RewrapVerificationError()

  const { data: updated, error: updateError } = await supabase
    .from('root_key_wraps')
    .update({
      wrapped: toPgBytea(wrapped.wrapped),
      nonce: toPgBytea(wrapped.nonce),
      alg: wrapped.alg,
    })
    .eq('user_id', userData.user.id)
    .eq('kind', 'recovery')
    .select('id')
  if (updateError !== null) throw updateError

  // RLS returns zero rows rather than an error when the row is not yours, so "no error" is
  // not "it worked". A silent no-op here would hand the user 24 words that open nothing.
  if (updated === null || updated.length !== 1) throw new RewrapVerificationError()

  return phrase
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i])

/** Resume without a password, from the non-extractable key persisted at last unlock. */
export async function resumeSession(): Promise<CloakSession | null> {
  const supabase = supabaseBrowser()
  const { data, error } = await supabase.auth.getUser()
  if (error !== null || data.user === null) return null

  const sessionKey = await recallSessionKey(data.user.id).catch(() => null)
  if (sessionKey === null) return null

  return { userId: data.user.id, email: data.user.email ?? '', sessionKey }
}

export async function signOut(): Promise<void> {
  // Key first. If sign-out failed halfway, a stored key with no session is the worse of the
  // two leftovers — it survives on the device, whereas a stale session cookie expires.
  await forgetAllSessionKeys().catch(() => undefined)
  await supabaseBrowser().auth.signOut()
}

async function finishUnlock(userId: string, email: string, rootKey: RootKey): Promise<CloakSession> {
  await rememberSessionKey(userId, rootKey).catch(() => undefined)

  const sessionKey = await recallSessionKey(userId).catch(() => null)
  if (sessionKey !== null) return { userId, email, sessionKey }

  // Private browsing and locked-down origins block IndexedDB. The session still works, it
  // just will not survive a reload — which is a usability cost, not a security failure.
  const { toSessionKey } = await import('@cloakcal/crypto')
  return { userId, email, sessionKey: await toSessionKey(rootKey) }
}

/**
 * Create the first workspace and calendar.
 *
 * The calendar's display name is Tier B and is encrypted here before it is sent, exactly
 * like every other piece of content. It would be easy to justify an exception for a default
 * name nobody chose — and that exception is how a plaintext column gets added.
 */
async function bootstrapWorkspace(userId: string, rootKey: RootKey): Promise<void> {
  const supabase = supabaseBrowser()

  const { error: profileError } = await supabase
    .from('profiles')
    .upsert({ id: userId, cloak_initialized_at: new Date().toISOString() })
  if (profileError !== null) throw profileError

  const { data: workspace, error: workspaceError } = await supabase
    .from('workspaces')
    .insert({ owner_id: userId, kind: 'personal', default_time_visibility: 'busy' })
    .select('id')
    .single<{ id: string }>()
  if (workspaceError !== null) throw workspaceError

  const { data: calendar, error: calendarError } = await supabase
    .from('calendars')
    .insert({ workspace_id: workspace.id, color_token: 'indigo', is_default: true })
    .select('id')
    .single<{ id: string }>()
  if (calendarError !== null) throw calendarError

  const name = await cloakField(rootKey, { type: 'calendar', id: calendar.id }, 'display_name', 'Personal')
  const { error: fieldError } = await supabase.from('cloaked_fields').insert(cloakedRow(
    'calendar',
    calendar.id,
    workspace.id,
    'display_name',
    name,
  ))
  if (fieldError !== null) throw fieldError
}

/** Shared shape for every cloaked_fields write, so no call site invents its own. */
export function cloakedRow(
  subjectType: 'event' | 'calendar' | 'workspace',
  subjectId: string,
  workspaceId: string,
  fieldName: string,
  payload: CloakedPayload,
) {
  return {
    subject_type: subjectType,
    subject_id: subjectId,
    workspace_id: workspaceId,
    field_name: fieldName,
    ciphertext: toPgBytea(payload.ciphertext),
    nonce: toPgBytea(payload.nonce),
    alg: payload.alg,
    key_version: payload.keyVersion,
  }
}
