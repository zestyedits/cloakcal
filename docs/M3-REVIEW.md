# M3 review packet — real auth, key lifecycle, Supabase read/write, week view

**For:** Codex (VS Code)
**Covers:** commits from `243a761` (M2 redacted read path) to HEAD
**Read alongside:** `docs/decisions/0002-root-key-lifecycle.md` (amended at M3), `docs/M1-REVIEW.md`

This packet exists because the review instruction was specific: real auth must include the
M3 key-lifecycle bridge, not just login. §1 is the part most worth your attention — it is a
correction to a decision this project had already accepted.

---

## 1. ADR 0002 was wrong, and is amended

**What it said:** the password wrap is "Argon2id over the account password".

**Why that is unsafe as written:** the account password is also the credential Supabase Auth
receives. Derive the wrapping key directly from it and CloakCal holds the exact KDF input at
every login. "We cannot read your events" degrades from a property of the mathematics to a
promise about our conduct, which is what plan decision D7 exists to forbid.

**What is built instead** — one expensive derivation, two independent cheap outputs:

```
masterSecret = Argon2id(password, salt = canonical(normalized email), 64 MiB / t=3 / p=1)
  ├── authSecret = HKDF(masterSecret, info = "cloakcal.auth.v1")  → Supabase password
  └── wrapKey    = HKDF(masterSecret, info = "cloakcal.wrap.v1")  → never leaves the device
```

Supabase bcrypts the authSecret, so the stored credential is a hash of a hash of an Argon2id
output. `keys.test.ts` asserts the separation directly: it constructs the AES key an attacker
holding the authSecret would build and shows the wrap does not open.

**Three consequences worth checking:**

| Consequence | Where |
|---|---|
| Salt is deterministic (from the email), because deriving the authSecret is a *precondition* of logging in — a random salt would need a pre-login fetch, which is an account-existence oracle | `kdf.ts`, documented in the ADR |
| KDF params travel with the wrap so they can be raised, and the **client enforces its own floor** so a server cannot lower them | `assertKdfParams`, `KDF_FLOOR` |
| Raising params later uses version probing (try current, fall back, rewrap), not a pre-login endpoint | ADR amendment 1 |

**Second amendment:** device pairing uses ECDH P-256, not X25519. X25519 reached WebCrypto in
Chrome 137 / Firefox 132 / Safari 18.4. Pairing is the path a user reaches for once their
other options have failed, and that is the worst possible moment to hit a browser gap.
Construction is ECIES with both public keys bound into the HKDF info.

**Open question for you:** is the deterministic-salt trade acceptable, or do you want a
pre-login `kdf_params(email)` endpoint despite the oracle it creates? We chose the oracle-free
option; Bitwarden and 1Password make the same call, but it is a real trade and worth a second
opinion.

---

## 2. What was built

| Area | Files |
|---|---|
| Key lifecycle | `packages/crypto/src/{kdf,wrap,recovery,device}.ts` + `keys.test.ts` (51 tests) |
| Key storage | `packages/cloak-store/src/key-vault.ts` — non-extractable `CryptoKey` in IndexedDB |
| Schema | `0006_root_key_wraps.sql`, `0007_create_cloaked_event.sql` |
| Auth surface | `components/{auth-form,recovery-phrase,unlock-panel}.tsx`, `lib/cloak-session.ts` |
| Real read path | `server/events.ts` — Supabase, as the signed-in user, no service role |
| Encrypted write path | `components/new-event.tsx` → `create_cloaked_event` RPC |
| Week view | `components/week-grid.tsx` |

### Points you may want to push on

**a. `create_cloaked_event` is a plpgsql function, which this project had avoided.**
It is `SECURITY INVOKER`, so RLS applies to every statement inside it exactly as outside; it
grants no privilege the caller lacked. Its only job is atomicity — two PostgREST calls cannot
be one transaction, and a failure between them leaves an event with no title, which renders as
"Private event" forever and is indistinguishable from a decryption failure.
`create-event.test.ts` includes the cross-workspace cases that a definer-rights version would
silently pass, plus an assertion on `pg_proc.prosecdef`.

**b. The root key is held as a non-extractable `CryptoKey`, not as bytes.**
`RootKey` still carries bytes because wrapping must encrypt them, but a live session holds
`SessionKey` — an HKDF key imported with `extractable = false`. IndexedDB stores it natively
and returns it still non-extractable, which is what ADR 0002 specified for the web surface.
Key theft becomes key *use*, which ends with the origin.

**c. The fixture still exists, deliberately, behind the same gate as the dev key.**
The instruction was to remove fixture-only data. The product path no longer reads it: real
data comes from Supabase. But the E2E privacy suite — the tests that assert a withheld title
is absent from the HTML — must be deterministic and offline, and pointing them at a live
project would make them depend on network conditions and on seed rows staying put. Tests that
go yellow for unrelated reasons stop being read, and these are the ones that must be read.

One flag, `NEXT_PUBLIC_CLOAKCAL_DEV_UNLOCK`, governs the fixture, the dev key and the
middleware bypass together, and all three check `NODE_ENV !== 'production'`. Next inlines
NODE_ENV at build time, so a production bundle cannot reach any of them. There is no
configuration in which the app serves fixture data it cannot decrypt, or reaches for the dev
key against real rows. **If you consider this unacceptable, the alternative is a seeded test
project and a slower, online E2E suite — say so and it changes.**

**d. `pnpm typecheck` did not cover `.tsx` until this milestone.** The root tsconfig included
only `apps/**/*.ts`, so every React component was checked by nothing until a production build
ran. Fixed; it found two real prop-type errors immediately.

---

## 3. Privacy properties, and how each is checked

| Property | Mechanism | Test |
|---|---|---|
| Server never receives the password | HKDF split, browser-only derivation | `keys.test.ts` "gives the server a credential that cannot open the wrap" |
| Server holds no wrap it can open | `root_key_wraps`, own-row RLS, no escrow | `root-key-wraps.test.ts` |
| Server modules cannot decrypt | Static import rule | `server-boundary.leak.test.ts` |
| Withheld content never reaches HTML or Flight | Redaction before render | `e2e/view-as.spec.ts` |
| Week view discloses no more than agenda | Both read one redacted page | `e2e/a11y.spec.ts` (two new cases) |
| Plaintext cannot be written | No title column, single-value enum, length check in the RPC | `create-event.test.ts` |
| Audit log carries no content | Metadata-only detail | `create-event.test.ts` |

---

## 4. Known gaps, stated rather than implied

1. **Device pairing has no UI.** The cryptography and the schema are complete and tested; the
   flow that shows a pairing code on one device and accepts it on another is not built. Until
   then a user has two wraps, not three.
2. **No password change / rewrap flow.** Changing a Supabase password today would leave the
   old password wrap in place and lock the user out. This must land before any real user
   exists — flagged as the highest-priority M3 follow-up.
3. **`visibility_rules` is still not read.** `server/audience.ts` uses demo rules. The engine
   and its vectors are real; the rules it evaluates are hardcoded until CRM-lite.
4. **Timezone is a module constant** (`DISPLAY_TIMEZONE`). There is no per-user column, and
   inventing one in a read path with no settings screen to change it would be worse.
5. **Day and Month views** are still disabled controls, honestly labelled.
6. **Independent security review** remains a hard gate before public launch. The M3 code is
   exactly the code that needs it.

---

## 5. Two questions

1. **Deterministic KDF salt** (§1). Accept the trade, or add a pre-login params endpoint and
   accept the account-existence oracle?
2. **Fixture behind the dev gate** (§2c). Acceptable for the E2E suite, or should the privacy
   tests run against a seeded live project?
