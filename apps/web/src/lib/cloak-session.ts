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

  const { data, error } = await supabase.auth.signUp({ email, password: authSecret })
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

/** Recovery path: the phrase opens the key, then the user sets a new password. */
export async function unlockWithRecoveryPhrase(
  email: string,
  phrase: string,
): Promise<CloakSession> {
  const supabase = supabaseBrowser()
  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError !== null) throw userError

  const { data: wrap, error } = await supabase
    .from('root_key_wraps')
    .select('kind, kdf, wrapped, nonce, alg')
    .eq('kind', 'recovery')
    .maybeSingle<StoredWrap>()
  if (error !== null) throw error
  if (wrap === null) throw new CloakSetupRequiredError()

  const rootKey = await unwrapRootKey(
    {
      kind: 'recovery',
      wrapped: fromPgBytea(wrap.wrapped),
      nonce: fromPgBytea(wrap.nonce),
      alg: 'aes-256-gcm-v1',
    },
    await deriveRecoveryWrapKey(phrase),
  )

  return finishUnlock(userData.user.id, email, rootKey)
}

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
