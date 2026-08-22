# 0011 — One passkey that signs you in and opens the calendar

**Status:** accepted, 2026-08-22. **Nothing here is implemented yet.**
**Supersedes nothing.** Extends ADR 0005, which added a passkey as a *wrap* and left
sign-in alone. **Related:** ADR 0002 (no escrow), ADR 0010 (one rule, both surfaces),
`lib/passkey.ts`, `lib/cloak-session.ts`, `components/auth-form.tsx`.

## Context

ADR 0005 gave the account a third way in and it worked: a `kind = 'passkey'` wrap exists on
a real account, created 2026-08-15, which is proof the two-prompt PRF ceremony completes on
real hardware. What it did not do is touch **authentication**. A passkey opens the vault; it
cannot open the door.

The practical shape of that, verified rather than assumed:

- A brand-new device has no session, so it gets the password form. `signInAndUnlock` derives
  the auth secret from the password, and Supabase has never heard of the credential.
- `UnlockPanel` offers the passkey only once a session already exists — that is, only on a
  device the password has already been typed on.
- `/recover` is the same: `recover-form.tsx` needs the emailed link to mint a session before
  it will accept a passkey.

So the feature helps on exactly the devices that least need help. A new phone still means a
password, which is the complaint that opened this.

**Two things changed since 0005 was written.** Supabase Auth shipped native passkey sign-in
(`signInWithPasskey()`, discoverable credentials, currently beta, requires
`@supabase/supabase-js` >= 2.105.0 — we are on 2.112.2). And the product now has to answer
for Windows and an eventual Capacitor shell, not just the machine it was built on.

## Decision

### 1. One credential does both jobs

Supabase's two-step API hands us the ceremony instead of running it:
`passkey.startRegistration()` returns options, we call `navigator.credentials.create()`
ourselves, `passkey.verifyRegistration()` takes the result. Because we run the call, we add
our own `prf` extension to the same request.

The credential Supabase registers for sign-in **is** the credential whose PRF output unwraps
the root key. Not two passkeys, not two prompts at enrolment beyond the two 0005 already
documents.

**The alternative was worse and was rejected.** Before finding Supabase's support, the design
on the table was to wrap the *auth secret* alongside the root key so a passkey could produce
a session itself. That puts a second secret in the wrap for no gain now that the platform
issues sessions against a public key it already holds. Not doing it is the point of this ADR.

### 2. Sign-in is two prompts, and the reason is RLS

1. `signInWithPasskey()` → session. One user verification.
2. Read this account's credential ids and `prf_salt` values, which RLS only permits now.
3. `evaluatePrfForAny()` → PRF output → unwrap. Second user verification.

**The salt cannot be read before the session exists**, and that is a property of the security
model rather than a sequencing mistake: `root_key_wraps` is keyed to `auth.uid()`. A single
fixed salt would collapse this to one prompt and is refused for the reason `evaluatePrfForAny`
already states — each wrap has its own salt, and one salt applied to whichever credential
answered derives the wrong key and fails as an unopenable wrap rather than as anything that
names the cause.

Caching a salt locally would also collapse it, and is deliberately **not** taken here: it
helps only on a device that has already signed in, which is the case that is already fine.

The copy says "two checks" before the first prompt. Same rule as 0005's enrolment: a second
prompt that was not announced reads as the first one having failed.

### 3. The promise is per device, not per account

**Passkeys sync within an ecosystem and never across one.** iCloud Keychain covers Apple,
Google Password Manager covers Android and Chrome, and neither reaches a Windows PC. Any copy
promising "set it up once" is false on the third device.

What is true everywhere, and what the product says instead:

> You type your password once per device. After that, never again on that device.

So **after any password sign-in on a device with no passkey, enrolment is offered
immediately**. That is the load-bearing step, not a nicety: it is what turns a platform
limitation into a one-time prompt. It must be skippable and must not nag.

The schema already assumed this. `evaluatePrfForAny` exists to offer "a laptop passkey and a
phone passkey"; `registerPasskey` takes `existingCredentialIds` so a second credential on the
same authenticator adds instead of replacing.

### 4. The Relying Party ID is `cloakcal.com`, and it is permanent

Supabase's own documentation is explicit that changing the RP ID makes every existing passkey
unusable. It is therefore chosen once, for a product that will have a native shell:

- **RP ID:** `cloakcal.com` — the bare apex, no scheme, no port, no path.
- **Origins:** `https://cloakcal.com`, plus `http://localhost:3000` for development.

A Capacitor iOS or Android shell reuses these same passkeys **only** if it ships an
`apple-app-site-association` and an `assetlinks.json` pointing at `cloakcal.com`. Choosing the
apex today is what keeps that door open; choosing a subdomain or a `*.vercel.app` would strand
the app behind a value that cannot be corrected later without invalidating everyone.

### 5. First run offers the passkey before it offers the words

`initializeCloak` already holds the root key and discards it; it returns it now, so enrolment
at first run needs no password re-prompt and no second Argon2id derivation. The caller holds
it for the length of the enrolment step and for nothing else.

Order becomes: create account → offer a passkey → recovery kit.

And the recovery step splits on whether a passkey was enrolled:

- **No passkey** → the mandatory transcribe-and-confirm ceremony, unchanged.
- **A passkey** → the words, a download, and Continue. No typing test.

**This is a real loosening and it is bounded.** The words are still generated, still shown,
still downloadable; what is dropped is the proof that they were transcribed, for a user who
demonstrably has a second way in. `reissueRecoveryPhrase` already exists, so "later" is a
promise the product can keep rather than a dead end.

## What this does not change

- **No escrow.** Supabase holds a public key and a challenge. It cannot open a wrap, and rule
  4 stands: there is still no service-role key.
- **The root key never changes.** A passkey is another wrapper around the same URK.
- **The phrase is not removed, and must not be.** A user holding only passkeys is one platform
  outage from lockout — 0005's argument, unchanged and now more load-bearing.
- **Password sign-in stays.** It is the fallback for every browser without PRF, and the only
  route on Windows builds older than the February 2026 update that added `hmac-secret`.
- **The server still cannot email anybody their calendar back**, which is the constraint that
  makes all of this necessary rather than a matter of taste.

## Consequences

**A beta dependency now sits in the sign-in path.** Supabase's docs say the passkey API may
change without notice. The blast radius is bounded by construction: our PRF wrap is
independent of it, so a break costs the sign-in convenience and not access to any calendar.
Password sign-in must therefore keep working and keep being tested, not become vestigial.

**Existing passkey wraps do not sign anybody in.** The 2026-08-15 credential was created by
our own ceremony, so Supabase has no record of it. It still unlocks; it cannot authenticate.
Those users re-register. Today that is one account, which is the cheapest this will ever be.

**`unlock-panel.tsx` becomes a primary surface**, and ADR 0010 already names it as the one
`role="dialog"` with no top layer, no focus trap and no Escape. It stops being the exception
as part of this work rather than after it.

## Still open

- **Google and Apple sign-in.** 0005 established the ordering — they prove identity and cannot
  hold a key, so those accounts need a passkey as their wrap and this ADR is what makes that
  possible. Both sit disabled in the dashboard. Separate decision.
- **Whether a passkey may authorise `reissueRecoveryPhrase`.** 0005 parked this and it stays
  parked; it is a bigger question now that a passkey can also open the door.
- **Whether the second prompt can ever be removed.** It could be, by a scheme that lets the
  salt be known before a session. Nothing here depends on it and no such scheme is proposed.
