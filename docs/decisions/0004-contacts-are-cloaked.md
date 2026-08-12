# ADR 0004 — Contact names, emails and group labels are Cloaked

**Status:** Accepted, 2026-08-11. Binding.
**Supersedes:** nothing. **Amends:** nothing.

## Context

Making View As real needs somewhere to put the people that `visibility_rules.audience_ref`
has pointed at since migration 0001. That column has always been an unconstrained `uuid`
commented "contact or group id", because no such table existed.

Building it forces a question the spec does not answer directly: is a contact's name Tier A
(server-processable) or Tier B (client-encrypted)?

The spec lists Cloaked fields as "title, location, notes, **attendees**, video links,
attachments" (§Data classes) and separately describes CRM-lite as "contacts with
names/emails/phones, tags/groups, private notes" (§Payments and contacts) without saying how
those are stored. So the two sections have to be reconciled rather than quoted.

## Decision

**Contacts and contact groups carry no plaintext identifying columns.** The tables hold an
id, a workspace, a group priority and timestamps. Names, emails, phone numbers, private notes
and group labels are encrypted client-side and filed in `cloaked_fields` under two new
subject types, `contact` and `contact_group`.

## Why

**1. Otherwise encrypting `attendees` achieves nothing.** Attendee lists are already Cloaked.
If the same people were stored in the clear one table over, anyone with database access could
reconstruct most attendee lists by inference — the encryption would be theatre. Two tables
cannot hold different opinions about how sensitive the same name is.

**2. The social graph is often more revealing than the content.** "Lunch" tells you nothing.
"Lunch, with a divorce lawyer" tells you a great deal, and it is the contact list that
supplies the second half. A group label — "Therapy", "Clients", "AA" — can be the single most
sensitive string in the account.

**3. It costs the user nothing they can perceive.** The obvious objection is search. A
personal address book is tens to low hundreds of rows; the client already holds the root key
and already decrypts through `packages/cloak-store`. Filtering an in-memory array of a few
hundred strings is faster than a network round trip, so client-side search is not a
degradation — it is the faster option.

**4. The engine never needed the name.** `packages/policy` matches a rule to a viewer by
comparing **ids**. Server-side redaction works identically whether the name is readable or
not, so nothing in the privacy path has to change.

## What this costs, stated plainly

**The server cannot answer "is this email address one of your contacts?".**

That is a real capability and it will be wanted. Booking pages let a stranger submit an email
address, and the natural behaviour is to recognise a known contact and apply their existing
visibility rules. With encrypted emails the server cannot do that lookup.

Booking is deferred by design and does not exist yet. When it does, it needs an explicit
mechanism and an explicit decision about what that mechanism leaks. The candidates:

- **A blind index** — a keyed hash of the normalised address, matchable but not readable.
  Weaker than it sounds: email addresses come from a guessable space, so anyone who can run
  the hash can confirm a suspected address. Acceptable only with a server-held key the
  attacker in the threat model does not have, which is a different security posture from the
  rest of this app.
- **Recipient-side matching** — the booking page fetches candidate envelopes and matches in
  the browser. Preserves the property; leaks the size of the contact list.
- **Explicit opt-in per contact** — the user marks a contact as bookable, which stores that
  one address in the clear, knowingly.

**None of these is "add a plaintext email column".** If a future migration does that, it
supersedes this ADR and must say so.

## Consequences

- Contact search, sort and dedupe are client-side. A UI that needs a server-side `ORDER BY
  name` cannot have one.
- Two new `cloak_subject` enum values, `contact` and `contact_group`. The existing
  `cloaked_fields_all` RLS policy is workspace-scoped and does not inspect subject type, so
  it covers them unchanged.
- `audience_ref` still has no foreign key. It is polymorphic across two tables and Postgres
  has no polymorphic references; composite `(id, workspace_id)` keys on the membership table
  are what keep an audience from resolving across a workspace boundary. A rule pointing at a
  deleted contact resolves to no match, which withholds rather than discloses.
- An account export must decrypt contacts client-side, exactly as it must for events.
