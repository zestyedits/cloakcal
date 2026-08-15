# ADR 0006 — A random KDF salt, considered and REJECTED

**Status:** Rejected, 2026-08-15. Binding as a record of why not.
**Supersedes:** nothing. **Amends:** nothing.

## What was proposed

Salting Argon2id with a random per-account value stored in the wrap's `kdf` blob, instead
of with the normalised account email, so that changing an email address stops silently
destroying an account.

## Why it was proposed

The email-as-salt hazard is real and is documented in CLAUDE.md: a new address derives a
different wrap key, the existing wrap stops opening, and the failure is indistinguishable
from a wrong password because both end in a failed AES-GCM tag. It is survivable today only
because there is no email-change UI. Adding Google and Apple sign-in looked like it would
change that — Apple's Hide My Email relay and Workspace domain migrations both alter an
address without asking.

## Why it is rejected

**It cannot be built, and `packages/crypto/src/kdf.ts` had already said so.** The comment is
sitting above the function:

> WHY A DETERMINISTIC SALT. The salt must be reproducible on a device that has not talked to
> the server yet, because deriving the authSecret is a *precondition* of logging in. A random
> per-user salt would have to be fetched first, which turns "does this account exist" into an
> unauthenticated oracle and adds a round trip to every unlock.

One Argon2id run produces one master secret, and that master feeds **both** halves:

```
masterSecret = Argon2id(password, salt)
  ├── authSecret → sent to Supabase AS THE PASSWORD   ← needed BEFORE any session exists
  └── wrapKey    → opens the root key                  ← needs the wrap, which needs a session
```

A salt stored in the wrap is unreachable at the moment the first half needs it. The
rejected ADR asserted the opposite — "the wrap is already fetched before the derivation
runs" — which is true of `rootKeyFromPassword` and false of `signInAndUnlock`, the path
that matters. Sign-in does not call `loadWrap` at all; it derives, authenticates, and only
then fetches.

The two ways out are both worse than the problem:

- **Split the salts** — email for the authSecret, random for the wrap key. Correct, and it
  costs a second 64 MiB Argon2id run on every sign-in. Roughly doubling the wait on the one
  interaction people already find slow, to fix a hazard that needs a UI we have not built.
- **An unauthenticated salt endpoint** — hand out a salt for any address someone asks
  about. That is an account enumeration oracle, and for this product "does this person use
  a privacy calendar" is often more sensitive than any event inside it.
  `signup-enumeration.client.test.ts` exists to keep exactly that out of the sign-up form.

## What we do instead

**1. The email stays the salt.** It is structurally required, and the trade is the one
Bitwarden and 1Password make.

**2. OAuth sidesteps it rather than colliding with it.** The hazard belongs to the
*password* wrap only. Recovery derives from the BIP-39 phrase; a passkey derives from the
authenticator's PRF output (ADR 0005). An account created through Google or Apple has no
password wrap at all, so there is no email-derived key to strand when the relay address
changes. This is the thing the rejected ADR got backwards: passkeys do not make a random
salt necessary, they make it unnecessary.

**3. A mismatch says so, instead of saying "wrong password".** `kdf.saltEmail` already
records the address a wrap was derived under, and nothing reads it. It should: when
unwrapping fails and the recorded address differs from the current one, the user is told
their account was set up under a different email and offered the phrase or a passkey —
rather than being told, falsely, that they typed their password wrong.

**4. Any future email-change UI must re-wrap first.** Open the key under the old address,
re-wrap under the new one, then change the address. Changing the address alone is the
destructive operation, and it must not be reachable.

## The general lesson, recorded because it was expensive

The rejected proposal reached "Accepted" without anyone reading the fifteen lines of prose
directly above the function it was changing. Those lines existed, named this exact failure,
and named both escape hatches. **When a decision looks obviously right, check whether the
code already argues against it** — this repo comments the *why*, and that is the reason.

## One thing worth keeping from it

Had a `salt` key been added to the `kdf` blob, `assertKdfParams` would not have validated
it. That function floors `memoryKiB`, `iterations` and `parallelism` against server-supplied
weakening, and a salt arriving from the same untrusted place would have had no floor at all
— a one-byte salt would have sailed through. Any future field added to that blob needs a
check in `assertKdfParams` in the same commit.
