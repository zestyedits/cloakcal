# ADR 0005 — A passkey wraps the root key, via the WebAuthn PRF extension

**Status:** Accepted, 2026-08-15. Binding.
**Supersedes:** nothing. **Amends:** ADR 0002 (adds a fourth wrap kind).

## Context

Forgetting a password today costs the user twenty-four words. That is not a UI failure and
cannot be fixed in the UI, so it is worth stating exactly where it comes from.

The root key persisted at unlock is a **non-extractable** `CryptoKey`
(`packages/crypto/src/cloak.ts`, `packages/cloak-store/src/key-vault.ts`). The browser will
use it and will never hand back its bytes. Re-wrapping the key to a new password needs
those bytes, so `rewrapPasswordWrap` takes a `RootKey` — and there is no function anywhere
converting a resumed `SessionKey` back into one. That is deliberate: it is the property
that keeps an injected script to being a decryption *oracle* for one session, rather than
letting it exfiltrate the key and read every past and future event offline, forever.

So every password change must re-derive the key from something the user supplies. Today
that is the password (which they have forgotten, or they would not be here) or the phrase.
One route, used every time.

The obvious shortcut — let an unlocked session re-wrap without proof — was considered and
rejected. Its real cost is not the missing prompt; it is that satisfying it requires
storing either the raw key or something that decrypts it, which turns the vault from "a
handle that can be used" into "material that can be read out". That is a categorical change
in what an XSS is worth, it violates ASVS V14.3.3 directly, and **this app still has no
Content-Security-Policy**, so nothing is currently holding the probability down. Wrong
order.

## Decision

**Add a fourth wrap kind, `passkey`, whose wrapping key is derived from the WebAuthn PRF
extension output for a registered credential.**

A passkey then does two things the phrase does today, and does them with a fingerprint:

- **Unlock** this browser without typing the account password.
- **Reset** the account password after an emailed link, without the phrase.

The 24-word phrase stays exactly as it is. It stops being the everyday route and becomes
the backstop for the case it was always for: no passkey, no trusted device, nothing left.

## Why PRF rather than the alternatives

**Against "just let an unlocked session re-wrap":** see above. It buys one prompt and sells
the non-extractable vault.

**Against device pairing** (the half-built option — the ECIES crypto in
`packages/crypto/src/device.ts` and the schema are done and tested): it does not help the
single-device user, who is most of the people with this complaint, and it needs an
out-of-band human-verified code before it is safe, because `wrapRootKeyToDevice` wraps to
whatever public key it is handed and the server is the one handing it over. Worth building
later; it is not the answer to *this*.

**Against server-assisted escrow** (Signal's SVR shape — a short PIN made safe by
rate-limiting inside an enclave): genuinely strong, and it needs an HSM, an attestation
story and a consensus layer. Not proportionate here, and it puts a key share on a server,
which ADR 0002 rules out.

**For PRF:** the secret is derived by the authenticator at the moment of use and requires
user verification — a biometric or the device PIN — to produce. Three consequences that all
point the same way:

1. **No new material at rest.** Nothing is added to IndexedDB, so the XSS calculus above is
   unchanged. This is the only option that improves the UX without touching the vault.
2. **An attacker at an unlocked laptop still cannot rotate the password**, because the
   assertion needs the user's finger or PIN then and there. The property the current gate
   protects survives.
3. **It survives losing the device.** Passkeys sync through iCloud Keychain and Google
   Password Manager, so a new phone still has the credential — which is exactly the case
   where a device-pairing scheme leaves the user holding twenty-four words.

Support is real rather than imminent: Safari 18+, Chrome 132+ and Firefox 139+ derive PRF
over iCloud Keychain passkeys on macOS 15, and Windows Hello gained `hmac-secret` in the
February 2026 cumulative update. Where PRF is unavailable the feature simply does not
offer itself, and the phrase is still there.

## Consequences

**Registering a passkey requires the root key.** The wrap has to be made from the actual
key, so enrolment asks for the password or the phrase once, at enrolment. This is correct,
not a wart: it is the same "prove it is you before minting a permanent way in" step that
`reissueRecoveryPhrase` already takes, for the same reason.

**It is a two-ceremony feature.** PRF output is not reliably available from
`navigator.credentials.create()`, so enrolment is: create the credential, then immediately
assert against it to obtain the PRF output, then wrap. The UI must not present that second
prompt as a failure of the first.

**More than one passkey per account, deliberately.** A laptop and a phone are two
credentials, and a user with one passkey and no phrase is one lost device from nothing. So
`passkey` is the first wrap kind that is *not* one-per-user: the partial unique index is on
`(user_id, credential_id)`. Getting this wrong reintroduces the silent fork that migration
0006's comments warn about.

**The PRF salt is stored beside the wrap, in the clear, and that is fine.** It is an HKDF
input, not a secret; the secret is the authenticator's PRF key, which never leaves it. It
is per-credential and random so that two credentials never derive the same wrap key.

**A revoked passkey means deleting its wrap, and that is honest but partial** — the same
limit ADR 0002 already records for device revocation. Deleting the wrap stops that
credential opening the key; it does not rotate the key, so a credential whose PRF output
was already captured retains what it captured. Saying so in the UI is required.

**The wrap kind is bound into the AAD for free.** `wrapAad` is generic over the kind
string, so `passkey` is domain-separated from the other three with no code change, and a
passkey wrap relabelled `password` will not open. That is ADR 0002's design paying off, and
`rewrap.test.ts` already pins the mechanism.

**Adding the kind is a migration, not an enum change.** `root_key_wraps.kind` is a CHECK
constraint, so it is drop-and-recreate plus new columns, a new partial unique index, and
the paired-column CHECKs extended. `WrapKind` and `loadWrap`'s union widen with it.

## Where it sits in sign-up

**Email and password stay the default way to create an account.** A passkey is something
you add afterwards, not something you must have to get started — decided deliberately,
because PRF availability still varies by platform and a sign-up that can dead-end on an
unsupported browser is worse than one extra step later.

Social sign-in (Google, Apple) is the reason this ordering matters. Those providers prove
identity and cannot hold a key, so an OAuth account needs some other wrap or it needs a
second passphrase. A passkey is that wrap, which is why it lands first and OAuth follows
it. Worth stating plainly in product copy when it does: signing in with Google tells Google
you use a privacy calendar, which is the same fact `signup-enumeration.client.test.ts`
exists to keep the sign-up form from leaking. Apple's Hide My Email is materially better
here.

An OAuth account has **no password wrap**, so it has no email-derived key and none of the
email-as-salt hazard ADR 0006 was written to solve — which is why that ADR turned out to be
unnecessary as well as unbuildable. A passkey is what opens the vault for those accounts.

## What this does not change

- **No escrow.** The server still holds only wrapped copies and still cannot open any of
  them. Rule 4 stands; there is no service-role key.
- **The root key never changes.** A passkey is another wrapper around the same URK, so
  nothing is re-encrypted and every other wrap keeps working.
- **The phrase is not removed, and must not be.** A user with only passkeys is one platform
  account lockout from losing everything. The phrase is the thing that does not depend on a
  vendor.

## Still open

- **CSP is now the highest-value security work on the board and outranks the next crypto
  change.** This ADR deliberately avoids making it worse, but "avoids making it worse" is
  not the same as addressed.
- Whether to offer PRF-unavailable browsers a device-pairing route instead, once pairing
  has its out-of-band verification.
- Whether a passkey should be allowed to authorise `reissueRecoveryPhrase`. It can hold the
  root key, so it *could*; whether rotating the last-resort credential should be reachable
  by a synced credential is a separate decision and is not taken here.
