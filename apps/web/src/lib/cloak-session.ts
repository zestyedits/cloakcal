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
  derivePasskeyWrapKey,
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
import { evaluatePrfForAny, registerPasskey } from './passkey'
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

/**
 * The wrap was derived under a DIFFERENT email address than the one signing in.
 *
 * The account email is the KDF salt, so a changed address derives a different wrap key and
 * the existing wrap stops opening — with nothing in the failure to say why, because a
 * failed GCM tag looks identical whatever caused it. `initializeCloak` and
 * `rewrapPasswordWrap` record the address each wrap was derived under, in the `kdf` blob,
 * and until now nothing read it back: the one clue we deliberately kept was never shown to
 * the person who needed it, who got "that password did not open your calendar" instead and
 * quite reasonably concluded they had mistyped.
 *
 * This is the honest remainder of ADR 0006, which proposed removing the email from the salt
 * entirely and was rejected because it cannot be built (the salt is needed before a session
 * exists). We cannot stop the hazard, so we name it.
 */
export class WrapEmailMismatchError extends Error {
  constructor(readonly wrappedUnder: string) {
    super(
      `Your calendar was set up under ${wrappedUnder}. Your key is derived from that ` +
        'address, so a different one cannot open it. Sign in with the original address, ' +
        'or use your recovery phrase to set it up again under this one.',
    )
    this.name = 'WrapEmailMismatchError'
  }
}

/** Asked to open with a passkey when the account has none registered. */
export class NoPasskeyError extends Error {
  constructor() {
    super('There is no passkey on this account yet. Add one from Settings, Security.')
    this.name = 'NoPasskeyError'
  }
}

/**
 * Refused to delete the only remaining way into the account.
 *
 * Not a security control — it is a guard against the user's own mistake, and it is the
 * first time one has been reachable, because until passkeys nothing could delete a wrap.
 */
export class LastWrapError extends Error {
  constructor() {
    super(
      'That is the only way left into your calendar, so it cannot be removed. Add another ' +
        'passkey, or set a password, and then remove this one.',
    )
    this.name = 'LastWrapError'
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
    // Authentication already succeeded, so the password was right for the ACCOUNT. Reaching
    // here means the wrap does not match it, and there is one cause we can actually name.
    //
    // The email is the KDF salt, so a wrap derived under a different address cannot open
    // however correct the password is. `kdf.saltEmail` records which address that was;
    // reading it back turns an inexplicable "wrong password" into a sentence that tells the
    // user what happened and what to do. Only a RECORDED mismatch is claimed — wraps
    // written before that field existed carry no saltEmail, and inferring one would be
    // guessing.
    //
    // Any other cause (a half-completed rewrap, a restored backup) still reads as "wrong
    // password", which remains the truthful summary: that distinction matters to us, not to
    // them.
    const wrappedUnder = saltEmailOf(wrap.kdf)
    if (wrappedUnder !== null && wrappedUnder !== normalizeAccountEmail(email)) {
      throw new WrapEmailMismatchError(wrappedUnder)
    }
    throw new WrongPasswordError()
  }
}

/** The address a wrap was derived under, when it recorded one. Untrusted jsonb, so typed. */
function saltEmailOf(kdf: unknown): string | null {
  if (typeof kdf !== 'object' || kdf === null) return null
  const value = (kdf as Record<string, unknown>)['saltEmail']
  return typeof value === 'string' && value !== '' ? value : null
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

/**
 * Persist an ALREADY-OPENED root key as this browser's unlocked session.
 *
 * Exists because opening the key and unlocking the browser are two different things, and a
 * caller that has just done the first almost always wants the second. The recovery reset
 * path proved that the hard way: it opened the key with the phrase, re-wrapped to the new
 * password, and navigated home WITHOUT ever persisting a session — so someone who had just
 * typed 24 words and chosen a password landed on the unlock panel and was asked to
 * authenticate again, at the single worst moment in the product to hit a dead end. The
 * comment there asserted the opposite of what the code did.
 *
 * Takes a RootKey rather than a credential on purpose: every route that opens the key —
 * password, phrase, and passkey — ends here, so none of them can forget this step in its
 * own way.
 */
export async function persistUnlockedSession(
  email: string,
  rootKey: RootKey,
): Promise<CloakSession> {
  const { data, error } = await supabaseBrowser().auth.getUser()
  if (error !== null) throw error
  return finishUnlock(data.user.id, email, rootKey)
}

/** Recovery path: the phrase opens the key, then the user sets a new password. */
export async function unlockWithRecoveryPhrase(
  email: string,
  phrase: string,
): Promise<CloakSession> {
  return persistUnlockedSession(email, await rootKeyFromRecoveryPhrase(phrase))
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

/* ------------------------------------------------------------------------------------- *
 * Passkey wraps (ADR 0005, migration 0023)
 *
 * The point of these is the "I forgot my password" story. Password and recovery are the
 * only two routes today, so forgetting one leaves twenty-four words as the single way back
 * in — which people reach for on a bad day, having written them down once, months ago. A
 * passkey is a third route that needs no memory at all, and because the PRF output is only
 * available after user verification, it is a route an attacker at an unlocked laptop still
 * cannot walk.
 * ------------------------------------------------------------------------------------- */

interface StoredPasskeyWrap {
  id: string
  credential_id: string
  prf_salt: string
  wrapped: string
  nonce: string
  alg: string
  created_at: string
}

/** One registered passkey, as the settings list needs it. */
export interface PasskeySummary {
  readonly id: string
  /** First bytes of the credential id, hex — the same "what the server files you under"
      convention the People register uses for contacts. */
  readonly shortId: string
  readonly createdAt: string
}

async function loadPasskeyWraps(): Promise<StoredPasskeyWrap[]> {
  const { data, error } = await supabaseBrowser()
    .from('root_key_wraps')
    .select('id, credential_id, prf_salt, wrapped, nonce, alg, created_at')
    .eq('kind', 'passkey')
    .order('created_at', { ascending: true })
  if (error !== null) throw error
  return (data ?? []) as StoredPasskeyWrap[]
}

export async function listPasskeys(): Promise<PasskeySummary[]> {
  const wraps = await loadPasskeyWraps()
  return wraps.map((wrap) => ({
    id: wrap.id,
    shortId: [...fromPgBytea(wrap.credential_id).slice(0, 4)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(''),
    createdAt: wrap.created_at,
  }))
}

/**
 * Register a passkey and file a wrap for it.
 *
 * Takes a RootKey rather than working from the session, for the same reason every other
 * wrap-writing function here does: the key persisted at unlock is non-extractable and
 * wrapping needs raw bytes. So the caller has already proved they can open the account,
 * which is the right bar before minting a new permanent way in.
 *
 * The ceremony runs BEFORE the insert and nothing is written if it fails, so a cancelled
 * prompt leaves no half-registered passkey behind.
 */
export async function registerPasskeyWrap(rootKey: RootKey, label: string): Promise<void> {
  const supabase = supabaseBrowser()
  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError !== null) throw userError
  const userId = userData.user.id

  // Existing credentials are excluded so a second registration on the same authenticator
  // ADDS a passkey rather than silently replacing the one already wrapped here.
  const existing = await loadPasskeyWraps()
  const { credentialId, prfSalt, prfOutput } = await registerPasskey({
    label,
    existingCredentialIds: existing.map((wrap) => fromPgBytea(wrap.credential_id)),
  })
  const wrapped = await wrapRootKey(rootKey, await derivePasskeyWrapKey(prfOutput), 'passkey')

  const { error } = await supabase.from('root_key_wraps').insert({
    user_id: userId,
    kind: 'passkey',
    credential_id: toPgBytea(credentialId),
    prf_salt: toPgBytea(prfSalt),
    wrapped: toPgBytea(wrapped.wrapped),
    nonce: toPgBytea(wrapped.nonce),
    alg: wrapped.alg,
  })
  if (error !== null) throw error
}

/** Does this account have any passkey at all? Decides whether to OFFER the route. */
export async function hasPasskey(): Promise<boolean> {
  const { count, error } = await supabaseBrowser()
    .from('root_key_wraps')
    .select('id', { count: 'exact', head: true })
    .eq('kind', 'passkey')
  if (error !== null) throw error
  return (count ?? 0) > 0
}

/**
 * Open the root key with a passkey. Does not unlock a session on its own.
 *
 * Every stored passkey is offered, and the one that ANSWERS decides which wrap to open —
 * see evaluatePrfForAny for why a single salt across credentials would silently derive the
 * wrong key for all but the first.
 */
export async function rootKeyFromPasskey(): Promise<RootKey> {
  const wraps = await loadPasskeyWraps()
  if (wraps.length === 0) throw new NoPasskeyError()

  const candidates = wraps.map((wrap) => ({
    credentialId: fromPgBytea(wrap.credential_id),
    prfSalt: fromPgBytea(wrap.prf_salt),
  }))

  const { credentialId, prfOutput } = await evaluatePrfForAny(candidates)

  const index = candidates.findIndex(
    (candidate) =>
      candidate.credentialId.length === credentialId.length &&
      candidate.credentialId.every((byte, at) => byte === credentialId[at]),
  )
  const wrap = wraps[index]
  if (wrap === undefined) throw new NoPasskeyError()

  return unwrapRootKey(
    {
      kind: 'passkey',
      wrapped: fromPgBytea(wrap.wrapped),
      nonce: fromPgBytea(wrap.nonce),
      alg: 'aes-256-gcm-v1',
    },
    await derivePasskeyWrapKey(prfOutput),
  )
}

/** Open with a passkey AND persist the unlocked session, which is what a user means. */
export async function unlockWithPasskey(email: string): Promise<CloakSession> {
  return persistUnlockedSession(email, await rootKeyFromPasskey())
}

/**
 * Remove a passkey wrap, REFUSING to remove the last way into the account.
 *
 * The schema does not enforce this and 0006's header claims the single-table design makes
 * the invariant "one query" — which it does, and nobody had written the query, because
 * until now nothing could delete a wrap at all. This is the first delete-a-wrap path the
 * product has ever had, so it is the first time the gap is reachable.
 *
 * It matters most for exactly the accounts this feature is FOR: an account created through
 * Google or Apple has no password wrap (ADR 0005), so its passkeys may be most of what it
 * has. Counting kinds rather than assuming password-and-recovery-always-exist is the
 * difference between a guard and a comforting story.
 *
 * Checked client-side, which is honest about what it is: a guard against the user's own
 * mistake, not a security boundary. Someone determined to brick their account can still
 * talk to PostgREST directly, and that is their key to destroy.
 */
export async function removePasskeyWrap(wrapId: string): Promise<void> {
  const supabase = supabaseBrowser()

  const { count, error: countError } = await supabase
    .from('root_key_wraps')
    .select('id', { count: 'exact', head: true })
  if (countError !== null) throw countError
  if ((count ?? 0) <= 1) throw new LastWrapError()

  const { error } = await supabase.from('root_key_wraps').delete().eq('id', wrapId).eq('kind', 'passkey')
  if (error !== null) throw error
}
