# CloakCal — Master Product & Architecture Specification

**Status:** Claude implementation brief  
**Product promise:** The calendar people choose because it is excellent, and keep because their time is not public information.

## 1. North-star and non-negotiables

CloakCal is a premium, privacy-first calendar, scheduling, and lightweight relationship-management product. It must be calm, approachable, and highly capable without looking like a security console or an overstuffed enterprise tool.

1. **Privacy is real behavior, not branding.** A user can Cloak sensitive event fields so they are protected client-side; normal calendar functions remain practical.
2. **Basic privacy is never paywalled.** Paid plans sell power, scale, professional workflows, integrations, automation, and customization—not the right to keep an appointment private.
3. **The user stays in control.** No silent privacy changes, silent overwrites, hidden billing changes, or irreversible surprises.
4. **CloakCal is the source of truth.** External calendar capabilities must never weaken or erase CloakCal privacy rules.
5. **Build working systems, not a feature graveyard.** Every feature passes its test gate before dependent work begins.

## 2. Design direction and experience rules

### Visual direction

Use all supplied reference images in this folder as the visual-quality target. Extract their hierarchy, spacing, layering, color restraint, typography, interaction patterns, depth, and premium finish; do not copy them mechanically.

- Mobile-first, responsive, app-like PWA from the first release; design API/business logic so a native iOS client can follow.
- Sleek, premium, slightly mysterious “cloak/reveal” language—never generic hacker/security-app dark mode.
- Calendar information must be clear at a glance. The product should feel tactile, fast, and composed.
- Support organized customization: theme, color system, density, event styles, layout/week start, motion preference, privacy defaults, notification behavior, and workspace appearance.
- Accessibility is a launch requirement: semantic controls, keyboard navigation, screen readers, high contrast, visible focus, reduced motion, large touch targets, and WCAG-minded color/interaction testing.

### Motion and progressive disclosure

Animation is product quality, not decoration. Use purposeful, performant motion for navigation, event creation, drawers, privacy-state changes, confirmations, loading/sync states, and hover/touch feedback. Respect reduced-motion preferences and never make motion the only feedback.

Do not place every option in front of users at once. Default flows should be short; reveal advanced controls contextually. Use sensible defaults, compact previews, short helper text, inline consequences, tooltips/on-demand help, and templates. Avoid giant onboarding walls and settings pages that read like an aircraft manual.

Privacy changes must always explain the result in plain language, e.g., “Clients will see the time and title; location and attendees remain hidden.” Use light, situational humor in non-critical moments (empty/loading states and gentle confirmations), never where it could obscure privacy, billing, security, or data-loss warnings.

## 3. Core product scope

### Calendar foundation

- Day/week/month/agenda views; multiple calendars; time zones; reminders; search; event templates; import/export.
- Create, edit, delete, restore, and version events. Full recurrence with safe editing choices: **this event**, **this and future**, or **entire series**.
- Attachments supported; Cloaked attachments encrypted client-side where applicable.
- Global search is fast for normal data. Cloaked contents are indexed/searchable locally/client-side only where required by the privacy model.
- Audit and activity history for important sharing, privacy-rule, booking, account/security, and team-admin changes; restore event versions where feasible.

### Workspaces, identities, and teams

One account may operate separate workspace-style identities (Personal, Freelance, Firm, Public-facing). Each identity has its own calendars, privacy presets, contacts/groups, booking links, notification defaults, integrations, team membership, and appearance.

The account owner has an optional combined master view. Cross-workspace visibility is user controlled: another workspace can receive full details, busy-only, or unavailable blocks; the owner may see full detail in the master view. Workspaces are real boundaries, not cosmetic folders.

Professional teams support policy-based controls. Admins can manage people, billing, organization-owned calendars, and explicitly shared content. Personal and Cloaked event content is inaccessible by default. A managed setting must visibly say it is organization-managed and why.

## 4. Privacy architecture: “Cloak”

### Hybrid protection model

Normal calendar metadata uses strong transport and at-rest encryption, conventional authorization, and practical server features. When a user Cloaks content, sensitive event fields use client-side encryption / end-to-end-style protection so the backend does not need plaintext to store or relay them. Treat keys and cryptographic implementation as security-critical: use reviewed primitives/libraries and have the final implementation independently security-reviewed.

Define an explicit event payload split:

- **Minimum operational metadata:** IDs, ownership/workspace, encrypted timestamps or availability representation as architecture permits, recurrence/sync/version metadata, policy references, and delivery state.
- **Cloaked fields:** title, location, notes, attendees, video links, attachments, and any selected custom fields; encrypted before leaving an authorized client.
- **Access envelopes:** recipient/device-bound encrypted key material only for audiences allowed to decrypt.

Do not claim blanket zero knowledge: CloakCal is a hybrid system. Clearly explain what Cloak protects, what metadata remains necessary, and how each chosen recovery option changes the threat model.

### Visibility engine

Support individual recipients, reusable groups, and public/booking audiences. Preserve this precedence exactly:

`explicit individual rule > applicable group rule > event default > workspace default`

Users get built-in presets plus custom presets. Standard display levels (Full details, Limited, Busy only, Hidden/availability only) are convenience layers over field-level rules.

Field-level visibility is configurable per audience for title, time, location, attendees, notes, video links, attachments, and extensible custom fields. Provide a one-tap “Cloak this event” action with safe defaults.

Time-based rules support delayed reveal, temporary access, automatic expiry/revert, and expiring booking/share links. Rules are evaluated deterministically by server/client time policy and logged. Smart privacy suggestions may be offered based on context, but **may never alter a privacy setting without explicit user acceptance**.

### Preview, notifications, recovery

- **View As:** individual, group, and public preview must render through the same authorization/redaction logic used for real recipients. It is a trust feature, not a mocked UI.
- **Notifications:** email, push, and in-app notifications respect the visibility engine. Default Cloaked notifications to a privacy-safe representation; users can choose lock-screen/preview defaults and per-event overrides. Show the exact planned notification preview before saving.
- **Recovery:** offer recovery key, trusted-device recovery, and optional secure recovery setup. Explain tradeoffs at setup; recovery must not silently weaken Cloaked protection.

## 5. Offline, sync, external calendars, and durability

### Offline-first

The application remains usable for create/edit/delete while offline through an encrypted local cache and durable sync queue. Clearly display local/sync state. Use idempotency keys and retries; never silently discard a queued action.

For concurrent edits, auto-merge non-overlapping field changes. If the same field conflicts, preserve both candidates, create a clear “needs review” state, and let the authorized user choose. Never use unannounced last-write-wins for true conflicts.

### Integrations and source-of-truth rules

Google, Outlook, and iCloud are future integrations. Per connected calendar, users choose import-only, two-way sync, or CloakCal-only/no export. Import onboarding must make switching easy and guide privacy defaults afterward.

CloakCal remains source of truth. If a provider cannot represent a Cloak rule, sync only safe/common fields and make the unsupported behavior explicit before it can leak. Never silently flatten privacy controls, corrupt CloakCal data, or overwrite a healthy local version after a provider failure. Surface actionable status such as token expiration or unsupported fields. A concise friendly warning may acknowledge that “other calendars occasionally choose chaos”; it must still state the risk plainly.

### Backups, restore, deletion, export

- Automated encrypted backups; tested, documented restore drills—not merely backup jobs.
- Explicit lifecycle: `active → trashed → purged`. Use configurable recovery windows plus an immediate permanent-delete choice.
- Quick event/calendar export: `.ics`.
- Full account archive: machine-readable JSON/CSV, settings, contacts/groups, privacy presets, booking configuration, and applicable attachments. Decrypt Cloaked content client-side for its owner’s export.
- Self-service export/delete works regardless of plan status, with clear progress, verification, and retention messaging.

## 6. Scheduling, CRM-lite, payments, and automation

### Booking

Booking is a product pillar. Provide branded booking pages per identity/workspace: custom URL/slug, logo/colors, meeting types, availability, buffers/minimum notice, location/video choices, intake questions, custom confirmation/reminder copy, and identity/contact disclosure controls.

Links can be public, private, PIN-protected, or expiring. Booking types support manual approval or rule-based approval (contact status, source/link, duration, time window, workspace, and custom criteria) and must show why a booking was approved or held.

Support smart waitlists and auto-offers: eligibility, ordered offers, configurable expiration, advancing to the next person, and per-booking-type opt-out.

### Payments and contacts

Use an isolated payments/billing adapter. Booking types may support full payment, deposits, optional payment, refunds, cancellation/no-show fees, promotions, and taxes. Provider changes must not require rewriting scheduling logic.

Build a private CRM-lite, not a general sales platform: contacts with names/emails/phones, tags/groups, private notes, booking history, workspace/identity association, privacy defaults/relationships, custom fields, and labels such as client/prospect/friend/VIP.

### Calendar-adjacent automation

Rule-based automations are scoped to booking type/workspace: thank-yous, questionnaires, payment reminders, feedback/review requests, and rebooking links. Preserve an audit trail, idempotency, opt-outs/consent rules, and clear failure/retry states. Do not expand V1 into a general workflow builder.

AI is optional and restrained. It is not a core promise, and it must never read Cloaked content without explicit permission; prefer local processing where practical.

## 7. Accounts, security, subscriptions, and support

### Authentication and account security

Support email/password, magic links, Sign in with Apple, Google sign-in, and passkeys when supported. Implement safe account linking and duplicate-account prevention. Add MFA option, device/session management, suspicious-login alerts, recovery methods, and revoke-all-sessions.

### Plans and entitlement architecture

Entitlements must be server-authoritative, auditable, and configurable without redeploying the app; support trials, monthly/annual prices, discounts, grandfathering, cancellation, and billing-webhook retries.

| Plan | Direction |
| --- | --- |
| Free | Core calendar and meaningful basic Cloak controls. |
| Pro (~$6–8/mo or ~$60–70/yr) | Advanced privacy controls/presets, customization, booking, integrations, and automations. |
| Professional (~$12–18/mo) | Advanced booking/payments, CRM-lite, multiple identities, stronger automation and professional controls. |
| Team seats | Incremental per-user pricing for Professional teams. |

Annual pricing should be visibly better value. No sales-led tier until customer needs justify it.

### Control Room, feedback, observability

Create an internal Control Room with permission-scoped user lookup, subscription/entitlement status, auth/session status, integration and sync health, error IDs, support history, and non-sensitive diagnostics. It must diagnose failures without exposing private event content by default.

In-app feedback: **Suggest something**, **Something broke**, and **Contact us**. With consent, attach non-sensitive diagnostic context (app version, OS/browser, route, error ID). Convert recurring reports into reproducible QA cases.

Capture structured, privacy-safe telemetry for availability, sync, notification delivery, billing webhooks, permission evaluation failures, job retries, and key product performance—not plaintext Cloaked content.

## 8. Delivery architecture and implementation boundaries

Claude should propose a stack after inspecting the repository, but preserve these separations:

1. Presentation clients (web/PWA, eventual iOS) call stable application APIs; business rules do not live solely inside UI components.
2. A domain layer owns events, recurrences, workspaces, visibility evaluation, booking, entitlements, lifecycle/versioning, and conflict resolution.
3. A cryptography/key-management boundary owns Cloaked serialization, encryption/decryption, access envelopes, and recovery flows.
4. An integration adapter boundary owns provider-specific calendar and payment behavior.
5. Background jobs own sync, retries, notifications, automations, backup/retention, and observability delivery.
6. Tests use seeded mock users, organizations, devices, providers, payment outcomes, calendars, and failure states—not production data.

Use explicit state machines and idempotency for high-risk workflows: sync operation, booking/payment, subscription, deletion/purge, notification delivery, and external OAuth connection.

## 9. Failure-state / “what if?” acceptance matrix

| What if | Required behavior |
| --- | --- |
| Device goes offline mid-edit | Save encrypted local draft/operation, show pending state, retry safely after reconnect. |
| Two devices edit the same field | Preserve both candidates; require resolution; no silent overwrite. |
| External provider token expires or rejects a change | Keep CloakCal source data intact; stop/retry safely; notify with remediation. |
| Provider cannot store a Cloak rule | Export only approved safe fields; flag the limitation before exposure. |
| A notification could leak sensitive data | Render from visibility policy and notification preference; default Cloaked event to safe wording. |
| A user loses credentials/device | Offer only the recovery methods configured; clearly state what can/cannot be recovered. |
| Billing webhook is delayed/repeated | Idempotent processing, durable reconciliation, correct entitlement outcome after refresh. |
| Payment fails/cancellation occurs | Preserve booking intent and explain state; never falsely mark a payment booking as confirmed. |
| Backup/restore is needed | Restore to an isolated target first; verify integrity and access rules before production use. |
| User deletes data by mistake | Recover from trash during configured window; permanent delete is explicit and logged. |
| Admin/support investigates an issue | Provide metadata/health diagnostics only unless content is explicitly organization-owned/shared. |
| User exports/deletes account | Reliable self-service flow, status/proof, and no plan-based restriction. |
| A feature/service dependency fails | Degrade to a clear usable state; disable only dependent action, retain data, and provide retry/support path. |

## 10. Quality gates: mandatory build loop

For every feature and before beginning dependent work:

`Implement → Test → Break → Fix → Retest → Integrate → Continue`

A feature is complete only when verified. At minimum, test expected behavior, invalid input, mobile and desktop layouts, persistence/reload, auth/session boundaries, workspace boundaries, privacy permissions, retries/duplicates, network failure, offline/reconnect, integration failure, accessibility, and relevant data migration/rollback paths.

### Required automated coverage

- Unit/domain tests: visibility precedence, field redaction, time-based rules, recurrence, conflict merge, lifecycle state transitions, entitlement logic.
- Integration tests: API authorization, encrypted payload handling, external adapters, OAuth/token refresh, payments/webhooks, queues/jobs, backup/restore.
- E2E tests with mock data: account → workspace → Cloaked event → group share → View As → refresh → sign in on simulated second device; booking/payment lifecycle; offline conflict reconciliation; export/delete/recovery.
- Visual regression tests across primary mobile and desktop breakpoints, including motion/reduced-motion states and reference-image-aligned visual review.
- Privacy leakage tests: recipient payloads, public booking pages, notifications, search, logs/telemetry, exports, support tools, and external sync must never reveal unauthorized content.
- App Store readiness checks: sign-in options and account deletion expectations, privacy disclosures, subscription flows, restore purchases where applicable, accessibility, data handling, and policy review before native release.

Do not mark a UI control complete because it exists. If a feature cannot be made reliable in the current milestone, document it as incomplete and hide it behind an explicit non-production flag rather than presenting fake functionality.

## 11. Suggested delivery sequence

1. Repository audit, visual-reference audit, shared architecture decision record, threat model, data model, and test harness.
2. Auth/accounts, workspace identity boundaries, normal calendar CRUD/recurrence, encrypted local store, basic PWA shell.
3. Visibility policy engine, Cloaked field encryption/access envelope prototype, presets, View As, privacy-safe notification rendering.
4. Offline queue, versioning/audit, conflict resolution, backups/restore, export/delete/recovery.
5. Booking pages, contacts/CRM-lite, approvals/waitlist, payments adapter, scoped automations.
6. External calendar adapters and import; then teams/admin policies, Control Room, feedback/observability.
7. Billing plans/entitlements, end-to-end hardening, visual polish, performance/accessibility, App Store/native-client preparation.

At each stage, maintain a living architecture document, test report, known limitations, and decision log. Do not proceed past the stage gate with known privacy, data-loss, authorization, or billing correctness failures.

---

## Claude kickoff prompt

Paste this into Claude after placing this file and all visual references in the project folder:

> You are building CloakCal, a premium privacy-first calendar and scheduling product. Before writing or changing code, review **every file in this folder**, especially `CLOAKCAL_MASTER_ARCHITECTURE.md` and all supplied visual reference images. Treat the master specification as the product source of truth; flag conflicts or ambiguities before making a consequential architectural choice.
>
> Work under one shared written architecture: data model, permission/visibility engine, Cloaked encryption boundary, offline sync/conflict strategy, API/domain boundaries, integration adapters, billing entitlements, and test strategy must be agreed before subagents implement pieces. Use subagents for bounded tasks, but require them to follow the shared architecture and return tests/assumptions—not independent product designs.
>
> Match the visual references at a top-tier commercial quality level: mobile-first, calm, premium, accessible, clearly understandable, and thoughtfully animated. Use progressive disclosure so advanced privacy power never overwhelms a new user. Inspect and use the supplied images as the visual standard.
>
> Enforce this gate for every feature: **Implement → Test → Break → Fix → Retest → Integrate → Continue.** Test with realistic mock data and automated unit, integration, E2E, visual, privacy-leakage, billing, sync/offline, accessibility, and failure-state coverage as relevant. Do not move to dependent features if the current one is unverified, and do not leave fake or merely decorative controls exposed. Report what you tested, results, remaining risk, and the next safe milestone after each completed feature.
