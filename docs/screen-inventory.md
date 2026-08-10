# CloakCal — Phase 1 Screen Inventory

**Status:** M0 deliverable. Living document — update it when a screen is added, cut, or built.

## Why this document exists

The supplied references are a brand foundation, not a screen set:

| Supplied | What it actually gives us |
|---|---|
| `Brand Info Concepts 2.png` | Visual Guide **Page 1 of 8** — palette, type, do/don't, core metaphor |
| `Brand Info Concepts.png` | Brand board with **two** rendered screens: desktop week view, mobile agenda + Event Visibility sheet |

Pages 2–8 of the Visual Guide were never supplied. So of the screens below, **3 are derived
from a reference** and the rest are extrapolated from the brand rules. Recording which is
which prevents a later claim of "matches the references" that the references cannot support.

**Legend**
- **D — Derived**: a reference image shows this screen; match it.
- **E — Extrapolated**: no reference exists; designed from tokens, spacing and the DO/DON'T list.
- **E\*** — Extrapolated *and* carrying a product decision that deserves a design review before build.

---

## 1. Shell & navigation

| # | Screen | Src | Notes |
|---|---|---|---|
| 1.1 | App shell — mobile (bottom nav: Day, Week, Cloak, Calendar, More) | **D** | Bottom nav is visible in the mobile mock. Thumb-reachable, 5 items, `--touch-min` 44px. |
| 1.2 | App shell — desktop (left sidebar: calendars list, mini-month) | **D** | Sidebar composition visible in the desktop mock. |
| 1.3 | Tablet / split shell | **E** | Sidebar collapses to a rail. No reference. |
| 1.4 | Offline / degraded banner | **E** | Spec §5 requires local/sync state always visible. |

## 2. Calendar views

| # | Screen | Src | Notes |
|---|---|---|---|
| 2.1 | Week view — desktop | **D** | The single most-specified screen. Time gutter, all-day row, coloured event blocks with privacy chips. |
| 2.2 | Agenda / day list — mobile | **D** | Date strip, "TODAY" divider, event rows with privacy chip on the right. |
| 2.3 | Month view | **E** | Density and overflow ("+3 more") behaviour undefined by references. |
| 2.4 | Day view — mobile | **E** | |
| 2.5 | Week view — mobile | **E\*** | Horizontal week on a phone is the hardest layout in the product. Needs its own review. |
| 2.6 | Search results | **E\*** | Cloaked content is searchable **client-side only** — results must show that scope honestly. |
| 2.7 | Empty states (no events, no results, first run) | **E** | Situational humour permitted here (spec §2), never on privacy/billing/data-loss copy. |

## 3. Event creation & editing

| # | Screen | Src | Notes |
|---|---|---|---|
| 3.1 | Quick create sheet | **E** | Progressive disclosure: title, time, calendar. Everything else behind "More". |
| 3.2 | Full event editor | **E** | |
| 3.3 | Recurrence editor | **E** | |
| 3.4 | Recurrence edit-scope prompt (this / this and future / entire series) | **E\*** | Spec §3 mandates all three. Destructive-adjacent; wording matters. |
| 3.5 | Attachment picker | **E** | Cloaked attachments encrypt client-side (M3+). Hidden until then. |
| 3.6 | Conflict "needs review" resolution | **E\*** | Must present both candidates without implying a winner. M4. |

## 4. Privacy — the product's centre of gravity

| # | Screen | Src | Notes |
|---|---|---|---|
| 4.1 | Event Visibility sheet — People / Groups tabs | **D** | The one fully-specified privacy screen. Four levels as cards, "Customize fields" toggles below. |
| 4.2 | One-tap "Cloak this event" confirm | **E\*** | Must state the consequence in plain language before it applies. |
| 4.3 | Field-level rules editor (per audience) | **E** | Pro tier (D5). |
| 4.4 | Preset picker + custom preset editor | **E** | Built-in presets are Free; unlimited custom presets are Pro. |
| 4.5 | Time-based rules (delayed reveal, expiry) | **E\*** | Pro. Needs an unambiguous "what happens when" preview. |
| 4.6 | **View As** — individual / group / public | **D**(partial) | Referenced conceptually by the brand board; no rendered screen. Trust feature: renders through the real policy engine. |
| 4.7 | Privacy explanation / "what CloakCal can still see" | **E\*** | Required by D1. Must plainly state that time, duration and recurrence are server-visible. Non-negotiable, not a footnote. |
| 4.8 | Notification preview before save | **E\*** | Spec §4: show the exact planned notification. |

## 5. Onboarding, account, security

| # | Screen | Src | Notes |
|---|---|---|---|
| 5.1 | Sign in / sign up | **E** | |
| 5.2 | First-run workspace setup | **E** | Short. No onboarding wall (spec §2). |
| 5.3 | Cloak setup — recovery phrase generation + confirmation | **E\*** | D7. The highest-stakes screen in the product: getting this wrong loses user data permanently. |
| 5.4 | Device pairing | **E\*** | D7. M3. |
| 5.5 | Devices & sessions list, revoke | **E** | |
| 5.6 | Recovery — restore from phrase | **E\*** | M3. |

## 6. Data lifecycle

| # | Screen | Src | Notes |
|---|---|---|---|
| 6.1 | Trash + restore | **E** | `active → trashed → purged`. |
| 6.2 | Permanent delete confirm | **E\*** | Explicit and logged. No humour. |
| 6.3 | Export (.ics + full JSON archive) | **E** | Owner's Cloaked content decrypts client-side. |
| 6.4 | Account deletion | **E\*** | Must work regardless of plan status. App Store requirement. |
| 6.5 | Audit / activity history | **E** | Append-only; rendered from `audit_log`. |

## 7. Settings

| # | Screen | Src | Notes |
|---|---|---|---|
| 7.1 | Settings home | **E** | Grouped, shallow. Not "an aircraft manual" (spec §2). |
| 7.2 | Appearance — theme, density, event style, week start | **E** | Light theme is itself an extrapolation. |
| 7.3 | Privacy defaults | **E** | |
| 7.4 | Notifications | **E** | Including the lock-screen default, per D3. |
| 7.5 | Accessibility — reduced motion, contrast, text size | **E** | |

---

## Counts

| | Screens |
|---|---|
| Derived from a reference (**D**) | 5 |
| Extrapolated (**E**) | 21 |
| Extrapolated, needs design review (**E\***) | 14 of those 21 |
| **Total Phase 1** | **26** |

## Rules that apply to every screen

1. **Colour is never the only signal.** Every privacy state carries colour + icon + text label. Enforced in `packages/ui/src/tokens.test.ts`.
2. **Motion is never the only feedback.** Reduced-motion collapses durations to 1ms; state must still be legible.
3. **Touch targets ≥ 44px** (`--touch-min`).
4. **Plain-language consequences** on every privacy control, phrased from the recipient's point of view.
5. **No decorative controls.** A control that does not work is not shipped — it sits behind a non-production flag (spec §10).
6. **Contrast is tested, not eyeballed** — all 16 semantic pairs assert ≥ WCAG minimums in both themes.

## Open questions for design review

1. Mobile week view (2.5) — is a horizontal week worth the complexity, or is day+agenda enough for V1?
2. Privacy explanation (4.7) — where does it live so users actually read it, without becoming an onboarding wall?
3. Recovery phrase (5.3) — how hard do we make it to skip? Skipping means permanent data-loss risk; forcing it adds friction at exactly the wrong moment.
