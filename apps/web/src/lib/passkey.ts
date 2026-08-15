'use client'

import { PRF_OUTPUT_BYTES, createPrfSalt } from '@cloakcal/crypto'

/**
 * The WebAuthn half of the passkey wrap (ADR 0005).
 *
 * 'use client' is REQUIRED here, and the leak suite is what said so — rule 2 forbids any
 * module under `apps/` without the directive from importing `@cloakcal/crypto`, and this
 * one imports it for the PRF salt. The directive is honest rather than a way past the
 * gate: `navigator.credentials` exists only in a browser, so there is no server rendering
 * of this file to preserve. It was missing because the file reads like a plain helper
 * module, which is exactly the case the static check exists to catch.
 *
 * Everything DOM-shaped lives here, and everything with a security consequence lives in
 * `packages/crypto/src/passkey.ts`. That split is the reason the derivation has real tests:
 * a mocked authenticator can only tell you that you called the API you thought you called,
 * whereas fixed PRF vectors tell you the key derivation is stable and separated.
 *
 * WHY BOTH FLOWS ALREADY HAVE A SESSION, which is what makes this simple. Reading a wrap
 * needs a Supabase session, because RLS keys the row to `auth.uid()`. That sounds like a
 * problem for "I forgot my password" — but the emailed reset link IS a sign-in: it comes
 * back through `/auth/callback` and creates a session before `/recover` renders. So by the
 * time we need the wrap, we can read it, and we can pass its credential id in
 * `allowCredentials` rather than relying on discoverable credentials. Same for unlocking a
 * resumed session whose vault has been cleared.
 */

/** How long to let a ceremony sit before giving up. Long enough to find a phone. */
const CEREMONY_TIMEOUT_MS = 120_000

export class PasskeyUnsupportedError extends Error {
  constructor() {
    super('This browser cannot use passkeys for encryption.')
    this.name = 'PasskeyUnsupportedError'
  }
}

export class PasskeyNoPrfError extends Error {
  constructor() {
    super(
      'That passkey was created, but this device would not derive an encryption key from ' +
        'it. Nothing was saved.',
    )
    this.name = 'PasskeyNoPrfError'
  }
}

export class PasskeyCancelledError extends Error {
  constructor() {
    super('That was cancelled, or it timed out.')
    this.name = 'PasskeyCancelledError'
  }
}

/**
 * Is the API even here?
 *
 * Deliberately NOT a claim that PRF works — nothing short of running a ceremony can tell
 * you that, because it depends on the authenticator the user picks at the prompt, not on
 * the browser. So this gates whether the option is OFFERED, and `PasskeyNoPrfError` is what
 * catches the rest. A feature that promises up front and fails at the end is worse than one
 * that admits it has to try.
 */
export function isPasskeySupported(): boolean {
  return (
    typeof globalThis.PublicKeyCredential !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    navigator.credentials !== undefined
  )
}

/** WebAuthn speaks base64url over the wire in some places and bytes in others. */
const toBytes = (buffer: ArrayBuffer): Uint8Array => new Uint8Array(buffer)

const randomChallenge = (): Uint8Array => {
  // The challenge exists to stop replay against a SERVER that verifies signatures. We
  // verify nothing: the security here comes from the PRF output being unavailable without
  // user verification, not from the assertion signature. A random challenge is still sent
  // because the API requires one and because a fixed one would be a landmine for whoever
  // later adds real server-side attestation.
  const challenge = new Uint8Array(32)
  globalThis.crypto.getRandomValues(challenge)
  return challenge
}

const prfOutputOf = (credential: PublicKeyCredential): Uint8Array => {
  const results = credential.getClientExtensionResults() as {
    prf?: { results?: { first?: ArrayBuffer } }
  }
  const first = results.prf?.results?.first
  if (first === undefined) throw new PasskeyNoPrfError()
  const bytes = toBytes(first)
  // Against the OUTPUT length, not the salt length. They are both 32 today, which is
  // exactly why using the wrong one would go unnoticed until one of them changed.
  if (bytes.length !== PRF_OUTPUT_BYTES) throw new PasskeyNoPrfError()
  return bytes
}

export interface RegisteredPasskey {
  readonly credentialId: Uint8Array
  readonly prfSalt: Uint8Array
  readonly prfOutput: Uint8Array
}

/**
 * Register a passkey and derive its PRF output.
 *
 * TWO CEREMONIES, and the UI must say so. PRF output is not reliably returned from
 * `create()` — Safari in particular gives you `enabled: true` and no results — so this
 * creates the credential and then immediately asserts against it. The user sees two
 * biometric prompts in a row, which looks like the first one failed unless the copy
 * explains it.
 *
 * Nothing is written anywhere if the second prompt does not produce a PRF output. A
 * credential with no wrap is a passkey that appears in the user's password manager and
 * opens nothing, which is worse than not having one.
 */
export async function registerPasskey({
  userId,
  email,
  label,
  existingCredentialIds = [],
}: {
  userId: string
  email: string
  label: string
  /**
   * Credential ids this account already has a wrap for.
   *
   * Without these, registering a second passkey on the SAME platform authenticator — same
   * rp, same user.id — replaces the resident credential instead of adding one. The first
   * wrap row survives, still lists in Settings, and never answers an assertion again. That
   * lands squarely on the last-wrap guard, which counts rows rather than working keys, so
   * "that is the only way left in" could be satisfied by a wrap that opens nothing.
   * Passing them lets the authenticator say "you already have one for this account".
   */
  existingCredentialIds?: readonly Uint8Array[]
}): Promise<RegisteredPasskey> {
  if (!isPasskeySupported()) throw new PasskeyUnsupportedError()

  const prfSalt = createPrfSalt()
  const userIdBytes = new TextEncoder().encode(userId)

  let created: PublicKeyCredential | null
  try {
    created = (await navigator.credentials.create({
      publicKey: {
        challenge: randomChallenge() as BufferSource,
        rp: { name: 'CloakCal' },
        user: {
          id: userIdBytes as BufferSource,
          name: email,
          displayName: label,
        },
        // ES256 then RS256. We never verify a signature, but an authenticator still has to
        // pick something it can do.
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: {
          // REQUIRED, not preferred. User verification is the entire security argument for
          // letting a passkey rotate a password: without it, an unlocked laptop is enough.
          userVerification: 'required',
          residentKey: 'preferred',
        },
        excludeCredentials: existingCredentialIds.map((id) => ({
          type: 'public-key' as const,
          id: id as BufferSource,
        })),
        timeout: CEREMONY_TIMEOUT_MS,
        extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null
  } catch {
    throw new PasskeyCancelledError()
  }
  if (created === null) throw new PasskeyCancelledError()

  const credentialId = toBytes(created.rawId)
  const prfOutput = await evaluatePrf(credentialId, prfSalt)
  return { credentialId, prfSalt, prfOutput }
}

/**
 * Ask an existing passkey for its PRF output.
 *
 * `allowCredentials` is populated from the stored wraps rather than left empty, so the
 * browser offers exactly the credentials that can actually open this account instead of
 * every passkey the user owns for this site.
 */
export async function evaluatePrf(
  credentialId: Uint8Array,
  prfSalt: Uint8Array,
): Promise<Uint8Array> {
  if (!isPasskeySupported()) throw new PasskeyUnsupportedError()

  let assertion: PublicKeyCredential | null
  try {
    assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: randomChallenge() as BufferSource,
        allowCredentials: [{ type: 'public-key', id: credentialId as BufferSource }],
        userVerification: 'required',
        timeout: CEREMONY_TIMEOUT_MS,
        extensions: {
          prf: { eval: { first: prfSalt as BufferSource } },
        } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null
  } catch {
    throw new PasskeyCancelledError()
  }
  if (assertion === null) throw new PasskeyCancelledError()

  return prfOutputOf(assertion)
}

/** Credential ids travel as base64url in the PRF extension's per-credential map. */
const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index])

export interface PasskeyCandidate {
  readonly credentialId: Uint8Array
  readonly prfSalt: Uint8Array
}

/**
 * Ask for ANY of this account's passkeys, and get back which one answered.
 *
 * `evaluatePrf` above takes a single credential and is right for registration, where we
 * know exactly which one we just made. Unlock is the other case: someone with a laptop
 * passkey and a phone passkey should be offered both and use whichever is to hand.
 *
 * That needs `evalByCredential` rather than `eval`, because EACH WRAP HAS ITS OWN SALT and
 * a single `eval` would apply one salt to whichever credential answered — deriving the
 * wrong key for every passkey but the first, and failing as an unopenable wrap rather than
 * as anything that points at the cause. The map is keyed by base64url credential id, which
 * is the one place in this file where WebAuthn wants text instead of bytes.
 *
 * `allowCredentials` is populated rather than left empty so the browser offers exactly the
 * credentials that can open THIS account, not every passkey the user owns for this site.
 */
export async function evaluatePrfForAny(
  candidates: readonly PasskeyCandidate[],
): Promise<{ credentialId: Uint8Array; prfOutput: Uint8Array }> {
  if (!isPasskeySupported()) throw new PasskeyUnsupportedError()
  if (candidates.length === 0) throw new PasskeyNoPrfError()

  const evalByCredential: Record<string, { first: BufferSource }> = {}
  for (const candidate of candidates) {
    evalByCredential[toBase64Url(candidate.credentialId)] = {
      first: candidate.prfSalt as BufferSource,
    }
  }

  let assertion: PublicKeyCredential | null
  try {
    assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: randomChallenge() as BufferSource,
        allowCredentials: candidates.map((candidate) => ({
          type: 'public-key' as const,
          id: candidate.credentialId as BufferSource,
        })),
        userVerification: 'required',
        timeout: CEREMONY_TIMEOUT_MS,
        extensions: { prf: { evalByCredential } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null
  } catch {
    throw new PasskeyCancelledError()
  }
  if (assertion === null) throw new PasskeyCancelledError()

  // Which one answered decides which wrap to open. Trusting the order of `candidates`
  // instead would open the right key only when the user happened to pick the first.
  const answered = toBytes(assertion.rawId)
  const matched = candidates.find((candidate) => sameBytes(candidate.credentialId, answered))
  if (matched === undefined) throw new PasskeyNoPrfError()

  return { credentialId: matched.credentialId, prfOutput: prfOutputOf(assertion) }
}
