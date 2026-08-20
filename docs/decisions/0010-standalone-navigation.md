# 0010 — Back, in a shell that has no back button

**Status:** accepted as a contract, 2026-08-20. **Nothing here is implemented yet.**
**Related:** `manifest.ts` (`display: standalone`), the four `<dialog>` sheets, ADR 0001's
habit of writing the divergence down rather than discovering it later.

## Context

The mobile redesign raised the question of an install path, and the honest answer was that
one cannot ship before this is decided. `manifest.ts` declares `display: 'standalone'`, which
means an installed CloakCal **has no browser back button**. The only Back is the platform's,
and the app currently listens for nothing.

Verified repo-wide, not assumed: there is no `pushState`, no `replaceState`, no `popstate`
listener, no `router.back()`, and no `closedby` anywhere in `apps/web/src`. The single
`closedby` mention in the tree is `e2e/visibility-sheet.spec.ts:63` asserting its **absence**.

So today, in an installed shell:

- Android hardware/gesture Back with a sheet open **leaves the calendar** rather than closing
  the sheet.
- Before it gets there it walks back through however many `#day-…` history entries the week
  strip pushed (`week-strip.tsx:114` is a plain fragment anchor, and nothing replaces those
  entries).
- iOS standalone has no system Back at all, so a route with no visible back control is a
  dead end.

Four `<dialog>`s, four different dismissal surfaces, none history-aware:

| sheet | Escape | explicit close | light dismiss | busy guard |
| --- | --- | --- | --- | --- |
| `EventSheet` (compose, edit, new calendar) | yes | Cancel | no | yes |
| `VisibilitySheet` | yes | Close | no, deliberately | yes |
| `CloakSheet` | yes | Close | no | **no** |
| `HotkeyHelp` | yes | Close | backdrop click | **no** |

Plus `unlock-panel.tsx:115`, which is a `<div role="dialog" aria-modal="true">` with no top
layer, no focus trap and no Escape — the pattern `event-sheet.tsx:12-17` condemns.

## Decision

### 1. Back closes the top thing before it leaves the page

Browser Back and Android system Back both close the topmost open sheet first, and only leave
the calendar when nothing is open. One rule, both surfaces: a Capacitor shell's hardware Back
and a browser's Back must not disagree about what "back" means.

### 2. A sheet is a history entry, and it is pushed, not replaced

Opening a sheet pushes one entry; closing it pops one. The alternative — intercepting Back
without a matching entry — means synthesising history, which is the trap
`legacy-hash-forward.tsx:36-41` already documents in this codebase: it uses `router.replace`
**because push left an entry whose own effect re-forwarded it, so Back could not escape the
control built for escaping**. That reasoning transfers directly. A sheet that pushes must pop
exactly one entry however it is dismissed — Escape, Close, backdrop, or Back — or the counts
drift and Back starts skipping pages.

### 3. Discard is decided before `closedby` is added

`closedby` (light dismiss) may not be added to any sheet until the discard rule exists,
because backdrop dismissal of a **dirty** editor loses work with no confirmation. The rule:

- A sheet with no unsaved change dismisses freely, by any route.
- A sheet with an unsaved change confirms before discarding, and Back is subject to the same
  confirmation as the backdrop. A confirmation that Back can bypass is not a confirmation.

`VisibilitySheet` already refuses light dismiss on purpose and keeps that refusal until the
above ships. Browser support for `closedby` must be verified on Safari and Android Chrome
before anything relies on it, rather than assumed from a support table.

### 4. Every full-screen route has a visible back route

iOS standalone has no system affordance, so this is the only way out. `PageShell`'s `back`
prop is **required**, so `/settings` and its five sub-routes, `/people`, `/people/[id]`,
`/contact`, `/privacy` and `/terms` are covered by construction.

The gaps, named: `/` (the calendar, which is the root and needs none), `/sign-in`,
`/sign-up`, `/recover`. Those three are pre-session and currently rely on links to each
other; they need auditing as a set before install ships, not individually.

### 5. Chrome's install eligibility is measured, never assumed

Whether `beforeinstallprompt` fires for this app **without a service worker** is an open
question and is to be answered against the deployed site, on a real Android Chrome. It is not
to be inferred from a support table or from a version number in a changelog — the criteria
have changed more than once and both possible answers are widely repeated.

**No service worker is added to find out.** With no offline strategy one is pointless; with
one it would imply offline editing that does not exist and would put a cache of ciphertext
responses inside a product whose threat model is that reading someone's calendar is the
attack. If a service worker is ever wanted it gets its own ADR.

### 6. iOS install guidance is an instruction, not a prompt

There is no install API on iOS. The path is "Share, then Add to Home Screen", shown only
when `matchMedia('(display-mode: standalone)')` is false, only to a signed-in user, and
permanently dismissible. It must say what installing does and does not give: a home-screen
icon and a full-screen app, **not** offline access, notifications, or background sync.

## Also parked here: document scrolling in browser mode

`.shell` is `height: 100dvh` with `main` as the scroller, so the **document never scrolls** —
and Safari minimises its toolbar on document scroll. It therefore never minimises, and the
app permanently spends ~100px of a phone screen on browser chrome. That is a consequence of
the shell rebuild that fixed the jumping bottom nav, and it is the strongest argument for the
install path: installing is what actually recovers those pixels.

Letting the document scroll in **browser** mode while **standalone** keeps the fixed app shell
is a real option. It is a real-device experiment, not a theory — `100dvh` behaviour under a
collapsing toolbar cannot be observed in Chromium at a synthetic viewport, and a wrong guess
reintroduces the jumping nav this shell exists to prevent.

## Consequences

- The install path does not ship before items 1 to 4, or it ships a shell whose Back button
  ejects the user mid-edit.
- `e2e` cannot cover most of this. Playwright has no hardware Back, no `navigator.standalone`,
  and its WebKit is not Safari. What can be covered: that a sheet pushes exactly one entry and
  that Back closes it in a browser. The rest is device work, and belongs on the release gate
  with the keyboard and safe-area checks.
- Anything that adds history entries as a side effect — the week strip's fragment anchors are
  the existing case — has to be counted against this contract rather than left to accumulate.
