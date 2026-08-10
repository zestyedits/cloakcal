# ADR 0001 — Wall-clock-preserving recurrence and DST policy

**Status:** Accepted (M0 review exit criterion 2). Binding on M1.
**Blocks:** all recurrence work.

## Context

Events were stored as `timestamptz` (a UTC instant) plus a separate IANA `timezone`
column. That is correct for a single fixed appointment and **wrong for a series**.

"09:00 every Tuesday" is not a repeating instant. It is a repeating *wall-clock reading*.
If only the UTC instant is stored, then on the Sunday a zone shifts, every subsequent
occurrence silently moves by an hour — the meeting appears at 08:00 or 10:00 and nobody
changed anything. Users experience that as data corruption, and rightly.

## Decision

**Recurring series are wall-clock preserving.** A 09:00 America/Los_Angeles meeting stays
at 09:00 local across a DST transition. The local time is authoritative; each occurrence's
instant is derived from it.

| Kind | Authoritative storage | Semantics |
|---|---|---|
| Single timed event | `start_utc` / `end_utc` + `timezone` | A fixed instant. Never moves. |
| Recurring series | `dtstart_local` (no zone) + `timezone` + `rrule` | Wall-clock. Each instant is resolved on read. |
| All-day event | `start_date` / `end_date` (`date`) | Date-only. No time, no zone, never shifts. |

`dtstart_local` is `timestamp without time zone` deliberately. It is a *reading*, not an
instant, and attaching a zone to it would reintroduce the ambiguity it exists to remove.

`start_utc` / `end_utc` remain populated for every event because range queries need an
indexable instant. For series and all-day events those columns are **derived**, not
authoritative — recorded as a column comment in the schema so the distinction survives
contact with a future engineer.

## DST edge policy

Two local times per year are not a simple function of wall clock, and both must be decided
rather than discovered in production.

### Ambiguous times (fall back — the hour occurs twice)

**Choose the earlier occurrence** (the first pass, still in daylight time).

Rationale: a 01:30 meeting on the repeat day should happen at the first 01:30, matching
both RFC 5545 practice and what every major calendar does. The UI may later expose an
explicit choice; until it does, the default is fixed and documented rather than emergent.

### Nonexistent times (spring forward — the hour does not occur)

**Shift forward by the length of the gap**, and **show the adjustment** when the series is
created or edited.

Concretely: when 02:00–03:00 does not exist, an 02:30 occurrence lands at **03:30**, not
03:00. This preserves the intended 30-minute position within the skipped hour. It is
`later` / `compatible` disambiguation in Temporal terms.

### Relationship to RFC 5545 — stated precisely

The two relevant sections of RFC 5545 do not say the same thing, and it would be wrong to
claim the standard simply requires this behaviour.

| Section | What it says | Our behaviour |
|---|---|---|
| **§3.3.5** (DATE-TIME) | A standalone TZID local time in a gap "is interpreted using the UTC offset before the gap", which yields **03:30**. An ambiguous local time "refers to the first occurrence". | **Matches.** Both the gap shift and the earlier-offset choice follow §3.3.5. |
| **§3.3.10** (RECUR) | A *generated recurrence instance* whose local time does not exist "MUST be ignored and MUST NOT be counted as part of the recurrence set". | **Deliberate divergence.** We shift the instance rather than dropping it. |

So: **ambiguous fall-back handling follows RFC 5545. Nonexistent spring-forward handling is
CloakCal product policy that knowingly diverges from §3.3.10**, by extending §3.3.5's
DATE-TIME interpretation to recurrence instances.

**Why diverge.** §3.3.10's rule silently deletes a meeting once a year. For a weekly 02:30
series that is a real appointment vanishing with no record, which contradicts spec §1's
promise of no silent, irreversible surprises. Dropping it is defensible for a protocol that
merely transports data; it is not defensible for the product a person relies on to show up.

**Cost of diverging.** A strict §3.3.10 implementation on the other side of a sync will not
generate that occurrence, so the two calendars disagree on exactly one instance per
transition. That is a real interoperability seam, it is bounded, and it must be tested
rather than assumed — see `packages/domain/src/ical.test.ts`, which asserts the divergence
explicitly so it can never become an accidental discovery.

> Amended after implementation (M1), twice. The section first read "shift forward to the
> first valid local time" (which implies 03:00) and then over-claimed RFC 5545 as requiring
> the shift. Both are corrected above.

Rationale for shifting at all: silently dropping an occurrence loses a meeting. Silently
moving it without telling anyone is the same class of unannounced change, so every adjusted
occurrence is tagged `nonexistent-shifted` and surfaced in the UI.

### Exception keys

`recurrence_exceptions.occurrence_local` stores the **original local occurrence**, not a
UTC instant.

If the key were an instant, a DST shift would change it, and a previously cancelled
occurrence would quietly reappear on the calendar. Keying by local time makes a
cancellation stable for the life of the series. This is enforced by the column type
(`timestamp without time zone`) and asserted in `packages/db/test/tier.test.ts`.

### Recipient rendering

Recipients see occurrences rendered from the **resolved instant**, expressed in the
recipient's own timezone. The organiser's wall clock governs when the event happens; the
viewer's zone governs how it is displayed.

## Consequences

- M1 must resolve occurrences through a zone-aware library. `rrule` alone is insufficient:
  it expands recurrences but does not handle wall-clock-preserving DST resolution, so it
  must be paired with proper zone maths (`@js-temporal/polyfill`).
- Property tests are required at M1 and are a gate condition, not optional: a series
  spanning a spring-forward and a fall-back in both hemispheres, an ambiguous 01:30 series,
  a nonexistent 02:30 series, and an all-day event viewed from three timezones.
- Changing a workspace or event timezone after creation is a **re-anchor**, not a
  reinterpretation. It must be surfaced explicitly, since it changes when every future
  occurrence happens.

## Rejected alternatives

**Store only UTC instants and expand from them.** Simplest, and wrong — this is precisely
the bug described above.

**Materialise every occurrence as a row at creation time.** Removes DST maths at read time,
but makes "edit this and all future events" a bulk rewrite, unbounded for a series with no
end date, and it was also floated as a way to reduce server-visible metadata. It does not
achieve that: materialised rows expose *more* timing metadata, not less.
