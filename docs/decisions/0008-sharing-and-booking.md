# 0008 — How anyone other than you ever sees anything

**Status:** accepted, 2026-08-16
**Supersedes:** nothing. **Related:** ADR 0004 (contacts are cloaked), ADR 0007 (plans),
rule 1 (not zero-knowledge), rule 3 (policy is the only visibility decision),
`CLOAKCAL_MASTER_ARCHITECTURE.md` §Booking.

## Context

**Nothing you configure today is visible to anyone, and that was not obvious from the
product.** Contacts exist (0015/0016), visibility rules point at them (0017), and View As
renders what each one would see. But View As is a simulation shown to the owner. Verified
rather than assumed, 2026-08-16:

- `access_envelopes` exists in the schema (0001) and is referenced by **zero lines** of
  application code.
- `workspaces.route_token` — 128 bits, widened in 0005, commented as an opaque routing id —
  is read by **nothing**.
- There is no `/share`, `/book` or `/c/[token]` route, and `PUBLIC_PATHS` names none.
- `deriveFieldKey` returns its key with `extractable: false`
  (`packages/crypto/src/cloak.ts:210`), so field key material **cannot be read out to wrap
  for a recipient** even if the rest existed.

So contacts and visibility rules are configuration for a delivery mechanism that was never
built. That is the gap this ADR closes, and the reason it exists at all is that the question
"how do my contacts actually see this?" had no answer in any document.

**The blend was the real confusion.** Booking and calendar sharing had been treated as one
future phase, and CLAUDE.md recorded booking as "gated on the share-key crypto ADR". That is
wrong, and believing it deferred work that was never blocked.

## The decision that unblocks everything

**Sharing splits by DISCLOSURE LEVEL, not by feature.** `decisionToLevel` already reduces
every policy decision to four steps — `full | limited | busy | hidden` — and the redaction
path emits **no ciphertext at all** at `busy` or `hidden`. There is nothing for a recipient
to decrypt, because the server sent them times and a busy flag and nothing else.

Therefore:

| Surface | What the viewer gets | Needs recipient decryption? |
|---|---|---|
| Booking page | free/busy slots | **No** |
| Share link, contact set to Busy only | busy blocks | **No** |
| Share link, contact set to Hidden | availability only | **No** |
| Share link, contact set to Limited or Full | titles, locations | **Yes** |

The crypto work gates the **top two levels only**. Booking and busy-level sharing can ship
against data the server already holds in the clear by design (rule 1, plan D1). This is the
single most useful thing in this document: it converts "sharing is blocked on a hard crypto
phase" into "sharing ships now and gets richer later, through the same surface".

## Decision

### 1. Booking pages: an opt-in vanity slug, and free/busy only

`cloakcal.com/b/<slug>`. The slug is **chosen, and empty until chosen** — there is no booking
page until you make one.

**A readable slug is guessable, and the page says so.** That is the trade being bought:
`route_token` is unguessable and stays available for anyone who wants a link nobody can find,
but a link you cannot say out loud is not a booking link. Opt-in plus a plain statement of
what a guesser can see ("your free and busy times, never your events") is the honest shape.
It is not an authorization boundary and must never be treated as one — same standing as
`route_token`'s own comment since 0004.

**An event never appears on a booking page, not even as a blank.** The page renders
availability windows (0027) minus busy intervals. A visitor sees candidate slots, not a
redacted calendar.

### 2. Published content is a third category, and it is not a weakening

A booking page must show *something* readable to a stranger: your display name, "30 minute
intro call", a description. That cannot be cloaked under the owner's root key, because the
stranger has no key and must never have one.

So there is **published** content — plaintext by the owner's explicit act — alongside
**cloaked** content. The two are never mixed and never share a table: publishing is
choosing to make a specific string public, not lowering the protection on an existing one.
No field ever moves from cloaked to published; you write a published string or you do not.

Rule 5 is untouched: `events` still has no plaintext content column. Published strings
belong to the booking page, not to any event.

### 3. Inbound booking details are sealed to a workspace public key

When a stranger books, they send a name, an email and answers. Those are Tier B content and
must not land in the clear.

The stranger cannot encrypt with the owner's key. So the workspace publishes an **ECDH P-256
public key**, the booker seals to it, and only the owner can open it. This is the same
primitive `packages/crypto/src/device.ts` already implements and tests for device pairing
(`wrapRootKeyToDevice` / `unwrapRootKeyWithDevice`), used in the opposite direction.

**This is NOT the share-key work.** It lets strangers write *to* you; it does not let anyone
read *from* you. It needs no extractable field keys and no `access_envelopes`.

### 4. Sharing with a contact: one link per contact

Each contact gets their own link. **The link identifies the audience**, the server runs that
contact's stored visibility rules through the same engine the owner's View As uses (rule 3),
and serves exactly what that audience may see.

Chosen over one-link-per-calendar because per-calendar sharing is all-or-nothing and bypasses
the per-contact rules that are the product's central idea. A share link that ignores the
visibility engine would make the engine decorative.

Consequences accepted deliberately:

- **Revocation is deleting the link**, which is a real capability rather than a policy edit.
- **The recipient needs no CloakCal account.** At busy/hidden there is nothing to decrypt; at
  limited/full the key rides in the URL **fragment**, which browsers never send to the server.
- Rules and links are two different objects. A rule says what an audience may see; a link is
  whether that audience can reach it at all. Both must be true.

### 5. What the top two levels will cost, recorded now so it is not rediscovered

Serving `limited` or `full` over a link means the recipient decrypts, which needs field key
material wrapped for them — `access_envelopes` populated, and `deriveFieldKey` no longer
returning a non-extractable key for that path.

**The unavoidable tension, stated rather than discovered later:** field-level rules require
re-encrypting per audience, which requires the OWNER'S BROWSER to be online to publish. So a
detail-level share goes **stale** until the owner next opens the app. Per-calendar keys would
stay live automatically but cannot express field-level rules. Busy-level sharing has neither
problem, because the server can serve it alone — which is a further argument for shipping it
first.

That work is a separate ADR. It is not started, and nothing in this document depends on it.

### 6. No payment collection inside booking

A booker never pays through CloakCal. Money happens outside.

Taking payment on a user's behalf is **Stripe Connect** — onboarding, KYC, connected
accounts, payouts, refunds, disputes, tax reporting — a product in its own right, and a
different thing from ADR 0007's Stripe Checkout for CloakCal's own subscriptions. Conflating
them is how a calendar becomes a payments company by accident.

### 7. Plan gating is deferred, and that costs nothing

ADR 0007 lists booking as planned Pro. It stays listed there. But booking ships before Pro is
purchasable, and that is safe for one reason: **sign-ups are closed, so there is no user to
take a feature away from.** The gate turns on with Stripe, before public launch.

This does not breach "basic privacy is never paywalled": booking is the work that happens
around your calendar, not the right to keep an appointment private.

## Consequences

- CLAUDE.md's "booking is gated on the share-key crypto ADR" line is **wrong** and is
  corrected. Booking is gated on nothing that is not now written down here.
- `route_token` and `access_envelopes` stop being dead schema — the first gains a use, the
  second gains a documented plan.
- Two new public routes, both of which must be in `PUBLIC_PATHS` and pinned by
  `middleware-paths.server.test.ts`. Both are reachable with no session, which is the exact
  shape that has broken three times here (`/auth/callback`, `/opengraph-image`, `/recover`).
- A booking page is the first surface where a stranger's request reaches the database. Every
  read it performs runs as `anon` under RLS, and rule 4 stands: no service-role key.

## Alternatives rejected

**Wait and build sharing once, complete, at all four levels.** Rejected because the crypto is
the longest pole and it would keep the product's central promise unusable for months, while
the two lower levels need none of it.

**One share link per calendar.** Simpler and stays live without the owner online, but
all-or-nothing per calendar and blind to the visibility rules. Rejected as making the engine
decorative; recorded because per-calendar keys may still be the right mechanism for the
detail levels later.

**A plaintext column for booking intake.** Rejected outright — it is rule 5 with a different
table name.
