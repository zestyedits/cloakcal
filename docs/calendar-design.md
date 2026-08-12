# The calendar, as the references actually draw it

Derived from `Brand Info Concepts.png` — the three product screens on that board are the only
screens the references specify. Everything here is **D — Derived** in the sense of
[screen-inventory.md](screen-inventory.md); anything not on the board and not listed here is
extrapolation and should be marked as such.

---

## The discrepancy to settle first

**All three rendered screens are LIGHT MODE.** The board's own chrome is dark, the Visual
Guide is dark, and `packages/ui/src/tokens.css` says *"Dark is the designed default; the brand
board is dark throughout."*

That last claim is wrong, and it has been driving the build. The marketing surfaces are dark.
The **product** — the week grid, the agenda, the visibility sheet — is drawn on white, with
pastel event blocks that only work on a light ground.

The app currently hardcodes `data-theme="dark"` on `<html>` with no way to change it.

**Decision: light becomes the default for the calendar, dark stays fully supported.** The
references are the product spec and they are light. The light palette already exists and is
already contrast-tested — it was built at M0 precisely so this would not be a retrofit. What
is missing is a theme toggle and a stored preference, which the settings work has to add
anyway.

Correct the false claim in `tokens.css` while doing it.

---

## Desktop week view

### Left sidebar — does not exist today at all

Top to bottom:

- **Logo lockup**, small.
- **"+ New Event"** — a full-width filled indigo button. Today there is no compose button
  anywhere; you get a sheet by clicking a date, which is undiscoverable.
- **Mini month.** `May 2025 ›` with a chevron, `S M T W T F S` header, six week rows, today in
  a filled indigo circle. Clicking a date navigates the main grid.
- **MY CALENDARS** — a section label in letterspaced caps, then a list. Each row is a small
  rounded colour swatch plus a name: Personal, Work, Private, Family. Then **"+ Add Calendar"**.

  The colours are per-calendar and they are the same colours the event blocks use. `calendars`
  already has `color_token`, and `getCalendarPage` already returns it — nothing renders it.

  **Calendar names are Cloaked** (`cloaked_fields` allows `display_name` on the `calendar`
  subject), so this list decrypts client-side exactly as the audience picker does.

### Top bar

- `‹ ›` step arrows and the range, `May 18 – 24, 2025` — both exist.
- **`Today`** button — missing.
- **`Week | Month`** segmented toggle, right-aligned — missing. Note the board shows only two
  segments here even though the phone has five nav items; the desktop toggle is view-switching,
  the phone bar is navigation.

### The grid

- Day columns headed by the date with a small weekday label above; today's date in a filled
  indigo circle. The app renders weekday + date without the emphasis.
- An **`all-day`** row above the hours. `week-grid.tsx` already splits all-day from timed and
  has a row for it.
- Hours 8 AM – 6 PM. The app already derives its window from the events present, which is
  better than a fixed range and should stay.

### Event blocks — the important one

Every block on the board carries **two lines**: the title, and beneath it a smaller label.

| Block | Second line |
|---|---|
| Team Standup | Work |
| Client Meeting | Limited Details |
| Lunch | Busy |
| Legal Call | Limited Details |
| Gym | Personal |
| Dinner with Family | Family |

So the second line is either the **calendar** or the **privacy level** — the board mixes both,
and the sensible reading is: show the privacy level when it is anything other than full
details, otherwise show the calendar. That makes the privacy state visible at a glance on
every event, which is the product's whole argument, without shouting on events that are not
restricted.

`PRIVACY_LEVELS` in `packages/ui/src/tokens.ts` already defines all four with labels, colours
and icons, and requires an icon alongside the colour so colour is never the sole carrier of
meaning. Nothing renders it.

---

## Mobile agenda

- Header: `☰` / `May` / `+`.
- **Week strip** under the header: `S M T W T F S` over `18 … 24`, today in a filled circle.
  Tapping a day scrolls or navigates. Does not exist today.
- Day heading: `Tuesday, May 20` on the left, **`TODAY`** in indigo on the right.
- **Event rows**: a coloured left bar (the calendar colour), title, time beneath it, and a
  **pill chip** on the right carrying the privacy level or calendar — `Limited`, `Busy`,
  `Personal`, `Family`.

  The app has a `Busy`/`Free` chip. That is the availability flag, not the privacy level, and
  the two are being conflated. The board's chip is the privacy state.

- **Bottom nav, five items:** `Day` `Week` **`Cloak`** `Calendar` `More`, with Cloak in the
  centre and active.

  This is a different information architecture from what is built. The app's bottom bar is
  Agenda / Day / Week / Month — four view switches. The board treats the bar as top-level
  navigation with a dedicated **Cloak** destination in the privileged centre slot, which is
  where the visibility controls live. That is a product statement: privacy is a place you go,
  not a setting buried in an event.

---

## Event Visibility sheet

The screen that makes the product real, and it maps one-to-one onto the policy engine.

- Header: `‹` back, **Event Visibility**, **Save** as an indigo pill.
- Segmented control: **People | Groups**.
- `Choose what people see for this event.`
- Four options, each an icon tile + title + one-line consequence, with the selected one
  carrying a check and the rest a chevron:

  | Option | Subtitle | Engine |
  |---|---|---|
  | Full Details | All event details are visible. | `timeVis: 'exact'`, all fields visible |
  | Limited Details | Only title, time, and location. | `timeVis: 'exact'`, `{title, location}` |
  | Busy | Shows as busy time only. | `timeVis: 'busy'`, no fields |
  | Hidden | Event is not shown at all. | `timeVis: 'hidden'` |

- **CUSTOMIZE FIELDS** section with per-field switches: `Location` on, `Notes` off,
  `Attendees` on.

Everything needed is in place: `set_visibility_rule` takes exactly `(audience, audience_ref,
time_vis, fields, event_id)`, and the four presets are already `PRIVACY_LEVELS`. The dead
`presets` table is this feature — built-in presets over field rules — and can now be filled in
or dropped.

**The sheet must not restate the rules in its own words.** `packages/policy` exports
`explainDecision` and `previewAs`; the subtitles should come from the engine, or the copy will
drift from the behaviour and nothing will notice.

---

## Build order

Each step is shippable on its own and none blocks the next.

1. **Theme.** Light default, stored preference, toggle. Fix the false claim in `tokens.css`.
2. **Event blocks and agenda rows carry the privacy level** — chip and second line, from
   `PRIVACY_LEVELS`, icon plus label. Cheapest change with the most product signal, and it
   needs no new screens.
3. **Desktop sidebar** — logo, New Event, mini month, calendars list with colours. This is the
   single biggest visual gap and it makes the desktop layout match the board.
4. **Today button and the Week/Month toggle**, which arrive with month view.
5. **Mobile week strip and the five-item bottom nav**, including deciding what the **Cloak**
   destination is.
6. **Event Visibility sheet**, wired to `set_visibility_rule`.

## What the references do not cover

No reference exists for: the day view, the month grid, settings, contacts, device pairing,
sign-in, recovery, or anything to do with sharing. Those stay marked **E — Extrapolated** in
`screen-inventory.md`. Pages 2–8 of the Visual Guide were never supplied and would most likely
settle several of them.
