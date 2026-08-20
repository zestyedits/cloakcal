# The 390px audit

**Run 2026-08-19** against `next dev` with the committed fixture, Playwright at 390×844, DPR 2,
both themes. 17 captures in `shots/` (untracked — regenerate rather than trust; they go stale).

This document records what the images actually show. Where a code-level prediction turned out
to be wrong, the correction is kept rather than the prediction, because the wrong ones are the
useful part.

---

## The one that has to be said first: `next dev` is not evidence for the calendar

**The fixture is dev-only by design.** `NEXT_PUBLIC_CLOAKCAL_DEV_UNLOCK` gates three things and
all three *also* check `NODE_ENV !== 'production'`, which Next inlines at build time. So a
production build cannot serve the fixture — verified: a build made *with* the flag set still
renders the landing page and the loading skeleton at `/`, never the calendar.

**Consequence for this audit: no calendar finding below can be reproduced in a local production
build.** The CSS is identical in both, and the layout depends on CSS plus event count rather
than on dev tooling, so the findings should hold — but "should hold" is not "verified", and one
finding (the document scroll, below) is explicitly parked because of it.

This is the same family as the contact-name ingest bug and the settings-hub counts: fixture-only
green is not evidence for a path the fixture cannot take.

---

## 1. Week view — the sticky gutter eats the first column. CONFIRMED, and it is worse on screen

`shots/05-week-snapped-dark.png`

The day header reads **"JE"** over **"9"**. That is `TUE` / `19` with its left half underneath
the opaque sticky hour gutter. The hour labels (`9 AM`, `12 PM`) paint *on top of* the first
column's event blocks, and the all-day row's `Person…` label bleeds across it.

The mechanism is as predicted: `.scroller` has `scroll-snap-type: x proximity` with
`scroll-snap-align: start` on every column, and **no `scroll-padding-left`**, while `.gutter`,
`.corner` and `.allDayLabel` are `position: sticky; left: 0; z-index: 2` with an opaque
background. Every snap position parks a column's left edge under 52px of gutter — half of a
104px column. `.blockTrigger` is `z-index: 1`, so taps in that strip hit the gutter.

**Correction to the earlier report:** it is *not* present at rest. The grid loads clean; the
defect appears on the first swipe. That matters for reproduction — anyone checking the default
view sees nothing wrong.

`scroll-padding-left: 3.25rem` on `.scroller` is the whole fix.

## 2. Week view — titles are sliced. CONFIRMED

Same capture. `13:30 / Legal / Private` has "Legal" cut horizontally through the middle of the
glyphs. Others read `Client`, `Proje…`, `Hidd…` — the horizontal ellipsis works, the vertical
loss is a hard cut with no indication, because `.event` has `overflow: hidden`, no `min-height`
and no `line-clamp`. A 30-minute block is 28px tall; the time line takes 15.6px of the 22px
content box, leaving 5.4px of a 15.6px title line.

`editable-event.module.css:41` already concedes the geometry ("the block cannot honestly reach
44px"), so this is a known condition that has never been designed for.

## 3. Half the phone is chrome before any calendar content. NEW — the biggest everyday cost

Measured, not estimated: the first event's top edge is at **370px** of an 844px screen. Above it
sit the header (69px), then a stacked sidebar strip (226px) containing the "VIEWING AS" card and
a "Make Week my default view" row, then the week strip.

`main` — the part of the app that is a calendar — gets **488px of 844**, and 64px of that is
dead padding (a stale comment says it clears a sticky nav that has owned its own grid row since
the shell was rebuilt).

Offline it is worse: the banner wraps to two lines at 390px (**51px**, not the 36px the CSS
min-height suggests) and pushes the first event to **449px**.

Nothing here is broken. It is simply a desktop sidebar stacked on top of a phone.

## 4. The FAB covers event content. CONFIRMED in two captures

`shots/13-offline-dark.png` — "+ New event" sits on top of the 09:00 *Client Meeting* row.
`shots/05-week-snapped-dark.png` — it covers the *Strategy Sessi…* block.

`bottom: calc(44px + 24px + inset)` gives 7px of clearance over a 61px nav at zero inset, and
the button is `z-index: 100` against the nav's `auto`. At 390px the `max-width: 380px` branch
that collapses it to a 44×44 `+` does not fire, so it keeps its full label and its full width.

Related, from the same geometry: the FAB is rendered *after* `</SealableMain>` and after
`<AudienceCover />`, so `inert` never reaches it and it floats above the opaque cover during an
audience switch — a live **New event** button over a screen that says "Changing view to Priya".

## 5. The document scrolls the whole shell away — PARKED, not confirmed

`shots/14-scrolled-away-dark.png` shows a blank screen with only the floating FAB. In `next dev`
at 390px, `document.documentElement.scrollHeight` is 1789 against an 844 viewport, and
`window.scrollTo(0, 3000)` really moves 945px, taking the header, the sidebar, the agenda and
the bottom nav with it.

Isolated to `main`'s content: hiding `<main>` drops the document to exactly 844, and nothing
outside `main` overflows. Not a dev-only DOM node — hiding Next's route announcer changes
nothing; hiding `.shell` removes all 945px.

**It is parked rather than ranked, because it cannot be reproduced in a production build here**
(see the note at the top), and the shell's own grid rows measure 0→69→295→783→844 with no
overflow, so the mechanism is not yet understood. It needs the throwaway-account recipe against
the deployed site before it is called a defect or dismissed. **Do not fix it on this evidence.**

## 6. The landing's first fold is better than the code predicted. CORRECTION

`shots/01-landing-fold-dark.png`

The code read said "microscopic type" and "half the week scrolled away with no cue". On screen:

- The hero is genuinely strong. Headline, subhead and eyebrow are large, legible and say what
  the product is within the first fold.
- Demo type at 11px renders **legibly** at DPR 2. It is still under the project's own stated
  floor and should rise, but "microscopic" was wrong.
- Roughly **2.7 of 5 day columns** are visible — Thu and Fri are off-screen. But the Wed column
  is cut *mid-column*, and the audience rail's third card is cut mid-word (`Marcu…` /
  `A collea…`). Both clipped edges do imply continuation. The affordance is weak, not absent.
- Titles ellipsise cleanly (`Discovery call, …`).

So the landing needs a **stronger continuation cue and a type bump**, not a rebuild. The
question the plan reserved — three-day excerpt versus horizontal week — is now answerable:
**keep the horizontal week.** The clipped-column edge already reads as "there is more"; what it
lacks is anything that says *swipe*, and the fourth audience (the wall-of-Busy case, which is
the most persuasive one) sits off-screen where nobody will find it.

## 7. Sheets are well made, and Save is where the keyboard will be

`shots/08-compose-dark.png`

The compose sheet is the best screen in the audit: bottom-anchored, generous spacing, legible
native date and time controls two-up at 390px, the `09:00 – 09:30` readout doing real work, and
Cancel/Save clearly separated. No fake drag handle, correctly, since drag is not implemented.

The defect is positional. The title field is `autoFocus`, so on a real phone the keyboard opens
immediately, and Cancel/Save are the last elements of a bottom-anchored `max-height: 92dvh`
sheet. Nothing in the app observes the keyboard — no `interactiveWidget`, no `VisualViewport`,
no resize listener — so `dvh` does not shrink and the primary action is behind the keyboard,
reachable only by scrolling inside the sheet.

**This is the one finding that cannot be honestly verified here at all.** Playwright does not
raise a real keyboard. The geometry makes it near-certain; a physical device settles it.

## 8. Copy and vocabulary, as rendered

- The offline banner reads `Offline — your calendar is read-only until you reconnect.` — an
  **em dash**, against the project decree. The e2e guards never see it because the banner
  returns `null` while online.
- `By default, others see [Limited details]` — the chip is on screen with its explanation in a
  `title` attribute, which does not exist on touch.
- The privacy chip truncates to `Hidd…` inside a week block.
- `Viewing as: Me` in the sidebar against `Previewing as …` in the preview bar: two verbs for
  one mode, and both can be on screen at once.

---

## What changed in the plan as a result

1. **The landing question is settled** — keep horizontal scrolling, add an unmistakable cue and
   raise the type. Not a three-day excerpt.
2. **Finding 5 is parked**, and was going to be ranked first. It would have been a fix built on
   a dev-server measurement.
3. **"Half the screen is chrome" is promoted.** It is the most-felt problem on the phone and it
   was not in the code-level list at all, because no grep finds "the sidebar is stacked above
   the calendar and costs 226px".
