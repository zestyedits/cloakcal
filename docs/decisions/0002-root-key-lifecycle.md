# ADR 0002 — Root key lifecycle

**Status:** Accepted (M0 review round 2). **Amended at M3** — see "M3 amendments" below.
**Implements:** plan decision D7 — recovery phrase + trusted device, no server escrow.
**Implemented by:** `packages/crypto/src/{kdf,wrap,recovery,device}.ts`, tested in `keys.test.ts`;
stored by `packages/db/migrations/0006_root_key_wraps.sql`.

## What the root key is

A **User Root Key (URK)**: 32 bytes from `crypto.getRandomValues`. It is the root of all
Cloak content protection for one user.

```
User Root Key (URK)                        32 random bytes, generated on device
  └── per-field key = HKDF-SHA256(URK, salt = canonical(subject), info = canonical(field, version))
        └── AES-256-GCM(plaintext, nonce = 96 random bits, aad = canonical(subject, field, version))
```

Per-field derivation is what makes field-level disclosure possible: releasing the key for
`title` releases nothing about `location`, and no ciphertext is rewritten.

## Generation

Client-side only, via `createRootKey()`. Generated once, at Cloak setup, on the user's
device. **The URK is never transmitted and never persisted server-side in any form.**

The server stores wrapped copies only, and only ones it cannot unwrap — see below.

## Storage, by surface

| Surface | Where the URK lives | Notes |
|---|---|---|
| Web / PWA | Non-extractable `CryptoKey` in IndexedDB | Wrapping keys are imported with `extractable = false`, so JavaScript cannot read the raw bytes back out. |
| Future iOS / native | Keychain, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` | Never synced to iCloud Keychain: that would move key material to a third party. |
| Server | **Wrapped copies only** | `root_key_wraps`, one row per wrap kind. The wrapping key never leaves the client, so a full database compromise yields no plaintext content. |
| Backups / logs / telemetry | **Never** | Asserted by the leakage suite. |

## The wraps (four kinds; see amendment 4)

The URK is wrapped independently. Any one recovers it; losing them all is unrecoverable,
by design.

| Wrap | Key derivation | Purpose |
|---|---|---|
| Password | Argon2id → HKDF split (see amendment 1), salt derived from the account email | Everyday unlock |
| Recovery phrase | 24 words (BIP-39 English), 256 bits + checksum, shown once and confirmed | Password loss |
| Device | Per-device ECDH P-256 keypair (amendment 2), private half non-extractable | New device, or phrase loss |
| Passkey | HKDF over the WebAuthn PRF output (ADR 0005, migration 0023) | Everyday unlock, and password loss without the phrase |

All of them produce the same shape — AES-256-GCM over the 32 URK bytes, with the **wrap kind
bound into the AAD**. Without that binding a wrap made for one slot would open in another,
so anyone able to write a row could file a device wrap as the password wrap and unlock the
account with a key they already held. That binding is generic over the kind string, which
is why adding a fourth kind needed no change to it.

---

## M3 amendments

### 1. The password wrap is derived through a split, not from the password directly

**What this ADR originally said:** "Argon2id over the account password".

**Why that was wrong:** the account password is also the credential Supabase Auth receives.
If the wrapping key were derived from it directly, CloakCal would hold the exact input to
the KDF at every login. "We cannot read your events" would become a statement about our
conduct rather than about the mathematics — precisely what D7 exists to prevent.

**What is built instead:** one expensive derivation, two independent cheap outputs.

```
masterSecret = Argon2id(password, salt = canonical(normalized email), 64 MiB / t=3 / p=1)
  ├── authSecret = HKDF(masterSecret, info = "cloakcal.auth.v1")  → sent as the Supabase password
  └── wrapKey    = HKDF(masterSecret, info = "cloakcal.wrap.v1")  → never leaves the device
```

HKDF is one-way and the labels differ, so the authSecret — which CloakCal stores, bcrypted,
and which anyone stealing the database obtains — yields nothing about the wrapKey.
`keys.test.ts` asserts this directly: it builds every key an attacker could construct from
the authSecret and shows the wrap does not open.

**Deterministic salt, stated plainly.** The salt comes from the email rather than a random
per-user value, because deriving the authSecret is a *precondition* of logging in and a
random salt would have to be fetched first — turning "does this account exist" into an
unauthenticated oracle. The email is unique per account and the salt is domain-tagged,
which is what defeats cross-service rainbow tables. Same trade Bitwarden and 1Password make.

**Parameter downgrade is refused, not trusted.** Parameters travel with the wrap so they can
be raised later. That means they arrive *from the server*, and a server that could lower
them could make every derivation cheap to attack. The client enforces its own floor
(19 MiB / t=2, OWASP's Argon2id minimum) and refuses anything weaker, so stored parameters
can only ever make a derivation more expensive.

**Raising parameters later** uses version probing, not a pre-login endpoint: a new client
attempts the current parameters, and on auth failure retries the previous set and rewraps
on success. This costs one extra derivation during a migration window and adds no
account-existence oracle.

### 2. Device pairing uses ECDH P-256, not X25519

X25519 reached WebCrypto in Chrome 137, Firefox 132 and Safari 18.4. P-256 has been
universal for a decade, including in the mobile webviews CloakCal targets. Pairing is the
recovery path a user reaches for when their other options have already failed, so
discovering a browser gap at that moment is the worst possible outcome. Both provide
roughly 128-bit security. The construction is ECIES — ephemeral keypair per wrap, HKDF over
the shared secret, **both public keys bound into the HKDF info** so a substituted recipient
key derives a different key rather than opening the wrap.

### 3. `devices.wrapped_root_key` is superseded by `root_key_wraps`

The original column predated the ephemeral public key an ECIES wrap requires, and left two
possible homes for a device wrap. Migration 0006 drops it and moves all three wrap kinds
into one table with own-row-only RLS.

**No server escrow.** CloakCal holds no wrap it can open. This is the difference between
"we cannot read your events" being a mathematical property and being a policy promise, and
it is why option 5.3(c) was declined at planning.

## Rotation

- **Password change** rewraps the URK under a new Argon2id-derived KEK. Content is
  untouched — no re-encryption, because content keys derive from the URK, not the password.
- **Device revocation** deletes that device's `root_key_wraps` row and its access
  envelopes. The URK itself is not rotated: a revoked device that retained a copy already
  had it, so rotation would be theatre unless content is also re-encrypted.
- **True URK rotation** (after suspected compromise) requires re-encrypting every Cloaked
  field, since every per-field key derives from it. This is a background job with explicit
  progress, and `key_version` on `cloaked_fields` exists so old and new material can
  coexist during the migration. **M3+.**
- **`key_version` is bound into both the HKDF info and the AAD**, so a rotated field cannot
  be confused with its predecessor even if an attacker replays old ciphertext.

## What is never persisted server-side

- The URK in plaintext, in any column, log, backup, telemetry payload or support tool.
- The account password, the Argon2id-derived KEK, or the recovery phrase.
- Any per-field derived key.
- Any decrypted Tier B content.

## Nonce discipline

96-bit nonces from the CSPRNG, fresh for every encryption including every update to an
existing field. Because keys are derived **per field**, the number of messages under any
single key is small (one per edit of one field of one event), which keeps random-nonce
collision probability far below the birthday bound that makes GCM nonce reuse dangerous.

Reuse under one key would be catastrophic — it leaks the XOR of plaintexts and enables
forgery — so `cloak.test.ts` asserts uniqueness across 1000 successive encryptions of the
same field under the same derived key, and asserts the nonce is drawn randomly rather than
counted.

## Encoding

All derivation and authentication inputs use a **length-prefixed canonical encoding**
(4-byte big-endian length per component, after a domain tag and component count), never
delimiter joining. Custom field names are user-supplied and can contain any character, so a
delimiter-joined encoding would be ambiguous. This removes the question rather than
requiring an argument about whether a given collision is reachable.

## Threat model summary

**Protects against:** database compromise, backup theft, a malicious or compelled server
operator reading content, and content leaking through logs, telemetry or support tooling.

**Does not protect against:** a compromised client device, a compromised browser
environment, or the operational metadata that Tier A necessarily exposes — existence,
timing, duration, recurrence and calendar partition (see plan D1). CloakCal is a hybrid
system and must never be marketed as zero-knowledge.
