# ADR 0006 — The KDF salt is random and stored, not the account email

**Status:** Accepted, 2026-08-15. Binding.
**Supersedes:** nothing. **Amends:** ADR 0002 (changes how the password wrap key is derived
for accounts created from now on).

## Context

`deriveMasterSecret` salts Argon2id with the normalised account email. That was a
reasonable default — a salt must be unique per user and an email already is — and it has
one consequence that has been documented in CLAUDE.md for months as a hazard:

> The account email is the KDF salt, so changing it is as destructive as changing a
> password. A new address derives a different wrap key and the existing wrap stops opening,
> with no error that says so.

Today that is survivable because there is no email-change UI, so the only way to hit it is
to go looking. Two things change that.

**Sign in with Google and Apple.** Apple's Hide My Email issues a relay address, and a user
who later turns it off, or switches from the relay to their real address, changes the
account email. Google Workspace domain migrations do the same thing to whole organisations
at once. Under OAuth this stops being a trap someone has to seek out and becomes routine
maintenance that silently destroys accounts.

**The failure is silent by construction.** A wrong salt produces a wrong key, and a wrong
key produces a failed AES-GCM tag, which is indistinguishable from a wrong password. The
user is told their password is wrong. It is not. Nothing anywhere says "this account was
set up under a different address", and the data is unreachable.

## Decision

**Accounts created from now on derive their password wrap key with a random 16-byte salt,
generated client-side and stored in the wrap's `kdf` jsonb as `salt`.**

Accounts that already exist keep deriving from their email. The `kdf` blob already records
`saltEmail` for exactly this kind of diagnosis, so the rule is unambiguous at read time:

- `kdf.salt` present → use those bytes.
- otherwise → use `saltEmail`, falling back to the current account email.

No migration of existing wraps, no forced re-derivation, no flag day. An existing account
moves to a random salt the next time it changes its password, because `rewrapPasswordWrap`
writes a fresh `kdf` blob and will write a random salt into it.

## Why

**A salt is not a secret and was never required to be meaningful.** Its job is to stop one
precomputed table attacking many accounts. Sixteen random bytes do that strictly better than
an email address, which is low-entropy, guessable, and often reused across services.

**It removes an entire class of unrecoverable failure**, rather than adding a warning to it.
The alternative — keep the email salt and refuse to let anyone change their address — does
not survive OAuth, where the identity provider changes the address without asking.

**It costs nothing to derive.** The salt travels with the wrap, and the wrap is already
fetched before the derivation runs (`loadWrap` precedes `unwrapWithPassword`). No extra
round trip, no new table, no new column.

**Rejected: re-wrapping every existing account at next sign-in.** Tempting, because then
there is one rule instead of two. But it means silently re-deriving a key during a routine
sign-in, and the failure mode of getting that wrong is the exact thing this ADR exists to
prevent. Two documented rules beat one clever migration touching every account's only
password wrap.

## Consequences

**Two derivation paths exist, and both are load-bearing.** `packages/crypto/src/kdf.ts`
takes a salt rather than an email, and the caller decides. A test pins that an existing
`saltEmail` wrap still opens, because deleting that path is the change that would strand
every account created before today.

**The email keeps being recorded in `kdf.saltEmail`** for accounts that use it, and is
worth keeping for new accounts too as a diagnostic — it says which address the account was
set up under even when it is not the salt.

**Changing an account email becomes safe for new accounts, and stays destructive for old
ones.** Any future email-change UI must check for `kdf.salt` and refuse, or re-wrap first,
for accounts without it. This ADR does not build that UI; it makes it possible.

**This does not touch the recovery or passkey wraps.** Neither derives from the email:
recovery derives from the BIP-39 phrase, and a passkey (ADR 0005) derives from the
authenticator's PRF output. The email salt was only ever the password wrap's problem.
