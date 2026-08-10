# ADR 0002 — Root key lifecycle

**Status:** Accepted (M0 review round 2). Sections marked **M3** are specified but not built.
**Implements:** plan decision D7 — recovery phrase + trusted device, no server escrow.

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
| Server | **Wrapped copies only** | `devices.wrapped_root_key`. The wrapping key never leaves the client, so a full database compromise yields no plaintext content. |
| Backups / logs / telemetry | **Never** | Asserted by the leakage suite. |

## The three wraps (M3)

The URK is wrapped independently three ways. Any one recovers it; losing all three is
unrecoverable, by design.

| Wrap | Key derivation | Purpose |
|---|---|---|
| Password | Argon2id over the account password, per-user random salt | Everyday unlock |
| Recovery phrase | 24 words (BIP-39 wordlist), 256 bits, shown once at setup and confirmed | Password loss |
| Device | Per-device X25519 keypair, private half non-extractable | New device, or phrase loss |

**No server escrow.** CloakCal holds no wrap it can open. This is the difference between
"we cannot read your events" being a mathematical property and being a policy promise, and
it is why option 5.3(c) was declined at planning.

## Rotation

- **Password change** rewraps the URK under a new Argon2id-derived KEK. Content is
  untouched — no re-encryption, because content keys derive from the URK, not the password.
- **Device revocation** deletes that device's `wrapped_root_key` row and its access
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
