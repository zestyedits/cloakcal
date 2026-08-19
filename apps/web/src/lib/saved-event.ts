/**
 * What a successful write reports back, and how its date is said.
 *
 * In `lib/` rather than beside either sheet because four components now name this shape — the
 * create sheet, the edit sheet, the row that hosts the edit sheet, and the screen that renders
 * the result — and a type defined in one of them would make the other three import from a
 * sibling for a reason that has nothing to do with what that sibling does.
 *
 * NOTHING HERE CARRIES CONTENT, and the type is the enforcement. There is no field a title,
 * location or note could arrive in: an event id is Tier A (the server assigns and stores it)
 * and a wall date is Tier A (the server needs it to place the event at all). So the obvious
 * future request — "make the confirmation say WHICH event was saved" — is a compile error
 * rather than something a reviewer has to catch. Same shape as `summariseSettings` taking
 * only counts.
 */

export interface SavedEvent {
  readonly eventId: string
  /** `YYYY-MM-DD`, the wall date the event now sits on. Never an instant. */
  readonly date: string
  /**
   * Which promise was kept. Create and edit are not the same one: a create may take you to
   * what you made, an edit must never move you away from what you were doing.
   */
  readonly kind: 'created' | 'edited'
}

/**
 * What a DELETE reports back, so it can be undone.
 *
 * Same no-content rule as SavedEvent, and here it is doing real work: `label` is the
 * "the event at 2 PM" string EditableEvent already builds from a time, never a title, so the
 * undo strip can name what went without naming what it was.
 *
 * `deletedFromVersion` is the version the client HELD when it deleted — not the version the
 * row now has. 0031's parameter is named `p_deleted_from_version` for the same reason: the
 * delete bumped it by one, and doing that arithmetic at the call site is how a `+ 1` rots.
 */
export interface DeletedEvent {
  readonly eventId: string
  readonly deletedFromVersion: number
  /**
   * The wall time of the single occurrence that was cancelled, or null when the whole event
   * was trashed. This is what picks the undo: an event is a ROW and comes back with
   * `restore_cloaked_event`; an occurrence is a SUBTRACTION and comes back by removing the
   * exception row. Conflating them would either resurrect a whole series or silently do
   * nothing.
   */
  readonly occurrenceLocal: string | null
  /** Describes the event without naming it. */
  readonly label: string
  /**
   * Whether the delete was activated from the KEYBOARD.
   *
   * It decides one thing only: whether focus moves to Undo. After a keyboard delete the sheet
   * unmounts and focus would land on <body>, so moving it is a rescue. After a MOUSE delete
   * the same move would yank a pointer user out of wherever their keyboard focus was, for a
   * control they can already see. Announcing and focusing are different decisions.
   */
  readonly keyboard: boolean
}

/**
 * The same weekday-and-date format the agenda's own day headings use.
 *
 * Parsed as UTC from a bare `YYYY-MM-DD`, which is the codebase's standing pattern for
 * formatting a wall date: `new Date('2026-03-26')` is already UTC-midnight by spec, and the
 * formatter is pinned to UTC so no host timezone can shift the label a day either way. The
 * failure this avoids is the quiet one — a date that renders correctly in Europe and one day
 * early in California.
 */
const DAY_LABEL = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
})

export const savedDateLabel = (date: string): string =>
  DAY_LABEL.format(new Date(`${date}T00:00:00Z`))
