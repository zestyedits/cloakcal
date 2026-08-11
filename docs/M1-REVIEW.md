# CloakCal M1 — Review Packet

**For:** Codex
**Scope:** domain layer, iCal boundary, CRUD service, decryption boundary, PWA shell, full test suite.
**State:** agenda view shipped; week, day and month deliberately not built.
**Ask:** confirm §3, and rule on the two open questions in §5. §5.1 is the one that affects M2.

---

## 1. Evidence

```
pnpm typecheck        exit 0
pnpm test             316 passed (15 files)
  domain    104   recurrence · DST · edit scopes · iCal round-trip
  db        103   RLS · tier discipline · security posture · CRUD gates
  crypto     25   AEAD · fail-closed · nonce · canonical encoding
  cloak-store 24  client boundary · server refusal · static import rule
  ui         23   WCAG contrast, both themes
  leak       34   Tier A/B separation · build output · fixture
  web-client  6   dev-key gating
npx playwright test    33 passed
  mobile+desktop 24   privacy leakage at both breakpoints
  a11y            6   axe WCAG A+AA, targets, focus, reduced motion
  visual          3   desktop · mobile · locked pre-hydration
Supabase advisor       0 lints
Production build       succeeds
```

## 2. What exists

| Layer | Package | State |
|---|---|---|
| Recurrence + DST | `packages/domain` | Complete for M1 |
| iCal import/export | `packages/domain/ical.ts` | Complete, divergence reportable |
| Event CRUD | `packages/db/src/events.ts` | Complete against fixture-shaped executor |
| Crypto | `packages/crypto` | Single-recipient AEAD; envelopes are M3 |
| Decryption boundary | `packages/cloak-store` | Complete |
| Design tokens | `packages/ui` | Complete, contrast-tested |
| Shell + agenda | `apps/web` | Agenda only |

**Not built, deliberately:** week/day/month views, real auth, Supabase-backed read path
(the service is written and tested; the shell reads a committed encrypted fixture),
offline outbox, policy engine, access envelopes.

---

## 3. Decisions taken since the M0 review

### 3.1 E2E runs against the dev server, not `next start`

The first attempt pointed Playwright at a production build. Every functional test failed,
because `getDevRootKey()` refuses to issue a key when `NODE_ENV` is production.

That is the gate working. The fix was **not** to relax it. Coverage now splits along the
line the gate already draws:

- **Production artifacts** — initial HTML, RSC/Flight payload, every chunk, caches —
  `apps/web/test/build-output.leak.test.ts`, against a real `next build`. It also asserts
  production renders *placeholders*, which is the gate holding in production.
- **Runtime client behaviour** — storage, error reports, console, network, a11y, visuals —
  Playwright against `next dev`, where the development key is legitimate.

Both halves covered; the gate untouched. Reasoning is recorded in `playwright.config.ts`.

### 3.2 Server-side recurrence expansion

`src/server/events.ts` expands series and returns resolved occurrences. Occurrence times
are Tier A (plan D1), so the server already knows them, and expanding once server-side
beats shipping an rrule engine to every client for every view change. The server still
cannot decrypt: it imports neither crypto package, enforced statically.

### 3.3 Committed encrypted fixture instead of a stubbed read path

`tools/generate-fixture.ts` encrypts at author time and commits hex. The server serves
real ciphertext without importing crypto, so the boundary is exercised for real rather
than simulated. The generator lives outside `apps/` on purpose — putting it under
`apps/web/scripts` would have forced an exclusion in the static rule, and a rule with
holes is one people stop trusting.

### 3.4 Separate production output directory

`next dev` was overwriting `.next`, destroying the artifacts the build-output leak suite
inspects. It failed loudly rather than vacuously, but the ordering dependency was a trap.
Production now builds to `.next-prod`.

### 3.5 Distinctive canaries

`Private`, `Family`, `Personal`, `Work` proved useless as leak canaries — `Family` matches
inside `fontFamily`, `Private` matches our own `"Private event"` placeholder. The fixture
now carries `Bramblewick Trust`, `Quarrystone Room`, `Marchpane clause` so calendar-name
and location leakage stay detectable without false alarms.

### 3.6 ADR 0001 amended twice

First to correct the gap-shift target (02:30 → **03:30**, not 03:00), then to stop
over-claiming RFC 5545. Ambiguous handling follows §3.3.5; the nonexistent-time shift
**knowingly diverges from §3.3.10**, which says such instances "MUST be ignored".
`divergentOccurrences()` reports exactly which instances a strict implementation will be
missing, so export can warn instead of silently disagreeing.

---

## 4. Defects the tests caught

Listed because they indicate where the suite has teeth, and where review would not have.

| Defect | Found by | Why it mattered |
|---|---|---|
| `loadSeriesSpec` read `dtstart_local` through the driver; PGlite parses zoneless timestamps in the **host** zone, so a 09:00 anchor returned 17:00 | CRUD round-trip test | The exact host-timezone dependence ADR 0001 exists to eliminate, re-entering at the driver boundary |
| Skip link was **40px**, under the 44px floor | a11y suite | The first control a keyboard user reaches |
| `verifyRange` was optional on a split | Review, then encoded as types + runtime guard | A split is the only edit that can destroy future occurrences |
| A verify range that does not straddle the split makes gate 3 **vacuous** | Writing the guard | Both sides come back empty and the comparison passes having checked nothing |
| `structuredClone` does **not** throw on class instances | CloakStore test | It silently copies enumerable properties — a leak path, not a blocked one |
| AAD used delimiter joining; custom field names are user-supplied and may contain `|` | Review round 2 | Same flaw was in the HKDF salt and info, affecting key *derivation* |

---

## 5. Open questions

### 5.1 The read path is not yet Supabase-backed — which order for M2?

`packages/db/src/events.ts` is written and tested against a `Db` interface, but `apps/web`
reads a committed fixture. Two orders are available:

- **(a) Wire Supabase first**, then the policy engine. The shell becomes real, but the
  read path gets built twice — once without redaction, once with — because M2 changes what
  a read returns.
- **(b) Policy engine first**, then wire a read path that is redacted from its first line.

I lean **(b)**: plan D2 makes the policy engine the only place a field-visibility decision
happens, and ADR 0003 forbids client-facing general reads before the redacted boundary
exists. Building an unredacted read path first means building something ADR 0003 says must
be replaced.

**Which order?**

### 5.2 Should the fixture survive M2, or be deleted?

It currently earns its place: it lets the leak suite run against real ciphertext with no
database. Once Supabase is wired, keeping it means two read paths to maintain; deleting it
means the leak suite needs a seeded database and CI gets slower and flakier.

I lean toward **keeping it** as the CI fixture and having the Supabase path exercised by
the db suite, but it is a maintenance cost and worth a second opinion.

---

## 6. Known limitations

- **Single-recipient crypto.** Every field is encrypted to the owner's root key. Access
  envelopes are M3; per-field derivation makes that additive.
- **Independent security review still outstanding** before any public launch.
- **`lock()` cannot wipe memory** — JS strings are immutable. Documented in ADR 0002.
- **21 of 26 Phase 1 screens remain extrapolated** from a brand foundation.
- **Desktop nav sits at the bottom**, where the reference board puts view tabs top-right.
  A deliberate deferral: worth changing alongside the week view, not before.
- **No auth.** The shell has no session; ADR 0003 keeps it single-owner regardless.

## 7. Files worth reading, in order

1. `docs/decisions/0001-recurrence-dst.md` — the DST policy and the RFC divergence
2. `packages/domain/src/recurrence.ts` — where `Date` is and is not allowed to decide
3. `packages/db/src/events.ts` — the five CRUD gates
4. `packages/cloak-store/src/store.ts` — the decryption boundary
5. `packages/cloak-store/src/server-boundary.leak.test.ts` — the static import rule
6. `e2e/leak.spec.ts` — the runtime leak surfaces
7. `apps/web/src/components/cloaked-text.tsx` — per-field subscription, and why
   `getServerSnapshot` returns `locked`

## 8. Proposed next milestone

**M2 — policy engine**, per plan: `packages/policy`, ~20 shared vectors, property tests,
server redaction, View As, and the `ViewAs ≡ serverPayload` contract test. Then the
redacted read path, then week view.

Blocked on §5.1.
