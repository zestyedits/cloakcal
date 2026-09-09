'use client'

/**
 * The wire format between a WebAuthn ceremony and Supabase Auth's passkey endpoints.
 *
 * WHY THIS FILE EXISTS AT ALL, given @supabase/auth-js ships the identical functions.
 * It ships them at `dist/module/lib/webauthn` and does NOT export them: the package's
 * public surface is `./lib/types` and `./lib/errors` only, and its `package.json` declares
 * no `exports` map beyond `main`. So importing `deserializeCredentialCreationOptions`
 * means reaching into a build directory that is free to move on any patch release, in the
 * one code path where a break locks every passkey user out of signing in. Forty lines of
 * base64url is the cheaper dependency.
 *
 * WHY WE SERIALISE AT ALL, rather than calling `auth.registerPasskey()` and letting the
 * library run the ceremony. We need the `prf` extension on the SAME credential Supabase
 * registers, and the high-level call does not take extensions. The two-step API hands us
 * the options and takes back a serialised response, which is the seam ADR 0011 needs: one
 * credential that Supabase can authenticate and whose PRF output opens the vault. The
 * alternative — a Supabase credential for the door and ours for the vault — means two
 * passkeys per device in the user's authenticator list, for no gain in prompt count.
 *
 * NOTHING SECRET PASSES THROUGH HERE. A credential id, a public key, a challenge and an
 * attestation are all values the server is meant to hold; the PRF output never enters this
 * file. Rule 2 is unaffected, and `'use client'` is honest rather than a way past the gate
 * — `navigator.credentials` exists in no other environment.
 */

/** base64url, no padding — WebAuthn's JSON encoding (RFC 4648 §5). */
export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * base64url back to bytes.
 *
 * The padding is restored before `atob`, which rejects a length that is not a multiple of
 * four. Supabase strips it, so a decoder that forgets this fails on roughly three quarters
 * of all challenges — intermittently, which is the worst way for it to fail.
 */
export function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** What Supabase's `startRegistration()` returns in `options`, as far as we touch it. */
export interface CreationOptionsJson {
  readonly challenge: string
  readonly rp: { readonly id?: string; readonly name: string }
  readonly user: { readonly id: string; readonly name: string; readonly displayName: string }
  readonly pubKeyCredParams: readonly { readonly type: 'public-key'; readonly alg: number }[]
  readonly timeout?: number
  readonly attestation?: AttestationConveyancePreference
  readonly excludeCredentials?: readonly { readonly id: string; readonly type: 'public-key' }[]
  readonly authenticatorSelection?: AuthenticatorSelectionCriteria
}

/** What `startAuthentication()` returns in `options`, as far as we touch it. */
export interface RequestOptionsJson {
  readonly challenge: string
  readonly rpId?: string
  readonly timeout?: number
  readonly userVerification?: UserVerificationRequirement
  readonly allowCredentials?: readonly { readonly id: string; readonly type: 'public-key' }[]
}

/**
 * JSON options to the real thing, with our extensions merged in.
 *
 * `userVerification` is forced to `'required'` rather than taken from the server, and that
 * is a security decision rather than a default: the PRF output only exists after the
 * authenticator verifies a human, and ADR 0005 leans on exactly that to argue an attacker
 * at an unlocked laptop still cannot walk this route. A server-chosen `'preferred'` would
 * quietly weaken it.
 */
export function toCreationOptions(
  json: CreationOptionsJson,
  extensions: AuthenticationExtensionsClientInputs,
): PublicKeyCredentialCreationOptions {
  return {
    challenge: fromBase64Url(json.challenge) as BufferSource,
    rp: json.rp,
    user: {
      id: fromBase64Url(json.user.id) as BufferSource,
      name: json.user.name,
      displayName: json.user.displayName,
    },
    pubKeyCredParams: [...json.pubKeyCredParams],
    ...(json.timeout === undefined ? {} : { timeout: json.timeout }),
    ...(json.attestation === undefined ? {} : { attestation: json.attestation }),
    excludeCredentials: (json.excludeCredentials ?? []).map((credential) => ({
      id: fromBase64Url(credential.id) as BufferSource,
      type: 'public-key' as const,
    })),
    authenticatorSelection: {
      ...json.authenticatorSelection,
      userVerification: 'required',
    },
    extensions,
  }
}

/** Same, for an assertion. */
export function toRequestOptions(
  json: RequestOptionsJson,
  extensions: AuthenticationExtensionsClientInputs,
): PublicKeyCredentialRequestOptions {
  return {
    challenge: fromBase64Url(json.challenge) as BufferSource,
    ...(json.rpId === undefined ? {} : { rpId: json.rpId }),
    ...(json.timeout === undefined ? {} : { timeout: json.timeout }),
    allowCredentials: (json.allowCredentials ?? []).map((credential) => ({
      id: fromBase64Url(credential.id) as BufferSource,
      type: 'public-key' as const,
    })),
    userVerification: 'required',
    extensions,
  }
}

/**
 * A created credential, in the shape `verifyRegistration` wants.
 *
 * `clientExtensionResults` is deliberately sent EMPTY. The PRF result belongs to us and
 * says nothing Supabase can verify, and the whole point of rule 2's habit of mind is that
 * key-adjacent material does not travel to a server that has no use for it. Supabase reads
 * the attestation and the public key; it has never needed the extension echo.
 */
export function fromCreatedCredential(credential: PublicKeyCredential): {
  id: string
  rawId: string
  type: 'public-key'
  clientExtensionResults: Record<string, never>
  response: { clientDataJSON: string; attestationObject: string; transports?: string[] }
} {
  const response = credential.response as AuthenticatorAttestationResponse
  const transports =
    typeof response.getTransports === 'function' ? response.getTransports() : undefined
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      attestationObject: toBase64Url(response.attestationObject),
      ...(transports === undefined ? {} : { transports }),
    },
  }
}

/** An assertion, in the shape `verifyAuthentication` wants. Same reasoning on extensions. */
export function fromAssertedCredential(credential: PublicKeyCredential): {
  id: string
  rawId: string
  type: 'public-key'
  clientExtensionResults: Record<string, never>
  response: {
    clientDataJSON: string
    authenticatorData: string
    signature: string
    userHandle?: string
  }
} {
  const response = credential.response as AuthenticatorAssertionResponse
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      authenticatorData: toBase64Url(response.authenticatorData),
      signature: toBase64Url(response.signature),
      ...(response.userHandle === null ? {} : { userHandle: toBase64Url(response.userHandle) }),
    },
  }
}
