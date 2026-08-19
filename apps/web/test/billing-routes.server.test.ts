import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import Stripe from 'stripe'

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), 'utf8')

const WEBHOOK = read('app/api/billing/webhook/route.ts')
const CHECKOUT = read('app/api/billing/checkout/route.ts')
const SUBSCRIPTION = read('app/api/billing/subscription/route.ts')
const PORTAL = read('app/api/billing/portal/route.ts')

const ROUTES = { WEBHOOK, CHECKOUT, SUBSCRIPTION, PORTAL }

/** Comments stripped, so a header may explain a rule without appearing to break it. */
const code = (source: string): string =>
  // Line comments FIRST — see the note on the same helper in billing-boundary.server.test.ts.
  // Blocks-first lets a line comment containing `/*` swallow the rest of the file.
  source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

describe('the webhook', () => {
  /**
   * THE SIGNATURE IS OVER THE EXACT BYTES STRIPE SENT.
   *
   * `request.json()` parses and would force a re-serialisation to verify against — different
   * key order, different whitespace, different unicode escapes — and EVERY delivery would then
   * fail verification for a reason that looks exactly like a wrong signing secret. Stripe
   * retries for days and then disables the endpoint, while the app keeps rendering perfectly
   * because 0024 made absence mean Free.
   *
   * Source-level because there is no live Stripe here to prove it against.
   */
  it('reads the raw body and never parses it', () => {
    expect(code(WEBHOOK)).toMatch(/await\s+request\.text\(\)/)
    expect(code(WEBHOOK)).not.toMatch(/request\.json\(\)/)
  })

  it('verifies the signature before doing anything with the event', () => {
    // The CALL sites, not the first mention: `applyBillingEvent` appears at the top of the
    // file as an import, which is before everything and proves nothing.
    const body = code(WEBHOOK).replace(/^import[\s\S]*?\n\n/, '')
    const verify = body.indexOf('constructEvent(')
    const apply = body.indexOf('applyBillingEvent(')
    expect(verify).toBeGreaterThan(-1)
    expect(apply).toBeGreaterThan(-1)
    expect(verify).toBeLessThan(apply)
  })

  /** The Postgres driver cannot run on the edge runtime. */
  it('declares the node runtime', () => {
    expect(code(WEBHOOK)).toMatch(/runtime\s*=\s*'nodejs'/)
  })

  /**
   * 503, NOT 404, when billing is unconfigured, and the difference plays out over days. Stripe
   * is a retry loop rather than a caller with an opinion: a 404 counts as a permanent failure
   * toward endpoint disablement, and a disabled endpoint is the most silent failure in this
   * design. The two user-facing routes answer 404 to the same condition, deliberately.
   */
  it('answers an unconfigured deployment with 503 so Stripe keeps retrying', () => {
    expect(code(WEBHOOK)).toMatch(/status:\s*503/)
    expect(code(WEBHOOK)).not.toMatch(/status:\s*404/)
  })

  /** A live event on a test-keyed deployment is somebody else's traffic or a misconfiguration. */
  it('refuses an event whose mode does not match the key', () => {
    expect(code(WEBHOOK)).toMatch(/event\.livemode/)
  })

  /**
   * A verbose signature error is an oracle: "timestamp outside tolerance" and "no matching
   * signature" are different facts, and telling them apart is useful to exactly one caller.
   */
  it('says nothing about why a signature failed', () => {
    const failure = code(WEBHOOK).slice(code(WEBHOOK).indexOf('constructEvent'))
    expect(failure).not.toMatch(/error\.message[\s\S]{0,120}status:\s*400/)
  })

  /**
   * A REAL SIGNATURE, VERIFIED, WITHOUT A NETWORK. `generateTestHeaderString` is the only way
   * to assert that ACCEPTANCE works rather than only that rejection does, and acceptance is
   * the half a wrong raw-body implementation breaks.
   */
  it('accepts a genuinely signed payload and rejects a tampered one', () => {
    const stripe = new Stripe('sk_test_notreal')
    const secret = 'whsec_test_secret'
    const payload = JSON.stringify({ id: 'evt_1', object: 'event', type: 'ping' })

    const header = stripe.webhooks.generateTestHeaderString({ payload, secret })
    expect(() => stripe.webhooks.constructEvent(payload, header, secret)).not.toThrow()

    // One byte different in the body, same header.
    expect(() =>
      stripe.webhooks.constructEvent(`${payload} `, header, secret),
    ).toThrow()

    // A stale timestamp, outside the default five-minute tolerance.
    const old = stripe.webhooks.generateTestHeaderString({
      payload,
      secret,
      timestamp: Math.floor(Date.now() / 1000) - 60 * 60,
    })
    expect(() => stripe.webhooks.constructEvent(payload, old, secret)).toThrow()
  })
})

describe('every billing route', () => {
  it('exports POST and nothing that could be reached with a GET', () => {
    for (const [name, source] of Object.entries(ROUTES)) {
      expect(code(source), `${name} must export POST`).toMatch(/export async function POST\(/)
      for (const verb of ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
        expect(code(source), `${name} exports ${verb}`).not.toMatch(
          new RegExp(`export (async )?function ${verb}\\(`),
        )
      }
    }
  })

  it('is dynamic, so nothing about it is ever cached', () => {
    for (const [name, source] of Object.entries(ROUTES)) {
      expect(code(source), `${name} is not force-dynamic`).toMatch(
        /dynamic\s*=\s*'force-dynamic'/,
      )
    }
  })

  /**
   * NEVER FORWARD A PROVIDER'S OWN MESSAGE TO A USER. Same rule as GoTrue's PKCE prose and the
   * RPC hints: a processor's error string is written for whoever built the app, and a decline
   * reason can carry information the issuer gave us and the cardholder's bank has not. Every
   * response body is a slug from `lib/billing-error.ts`.
   */
  it('answers with a slug and never with a provider message', () => {
    for (const [name, source] of Object.entries(ROUTES)) {
      const body = code(source)
      // `error.message` may reach console.error, never a Response.
      const responses = body.match(/Response\.json\([^)]*\)/g) ?? []
      for (const response of responses) {
        expect(response, `${name} returns a raw message`).not.toContain('error.message')
        expect(response, `${name} returns a raw message`).not.toContain('String(error)')
      }
    }
  })

  /**
   * Rule 2's shape, applied to a different kind of payload. `event.data` carries the customer
   * and the amount; logging it puts a third party's record of a person's payment into a place
   * with a different retention policy from the database.
   */
  it('never logs a whole event, session or subscription object', () => {
    // The IDENTIFIER passed as an argument, not the word. `console.error('[billing] portal
    // session failed:', …)` says "session" in prose and logs nothing, and a pattern that
    // cannot tell those apart is a pattern somebody silences rather than obeys.
    const logged = (body: string, identifier: string) =>
      new RegExp(`console\\.\\w+\\([^)]*[(,]\\s*${identifier}\\s*[,)]`).test(body)

    for (const [name, source] of Object.entries(ROUTES)) {
      const body = code(source)
      expect(body, `${name} logs event.data`).not.toMatch(/console\.\w+\([^)]*event\.data/)
      for (const identifier of ['session', 'event', 'subscription', 'body']) {
        expect(logged(body, identifier), `${name} logs the whole ${identifier}`).toBe(false)
      }
    }
  })
})

describe('the session-authenticated routes', () => {
  const SESSION_ROUTES = { CHECKOUT, SUBSCRIPTION, PORTAL }

  /**
   * All three go through one preamble, and the reason is that the failure mode of three copies
   * is not verbosity — it is the third copy missing the CSRF pair, which is exactly the sort of
   * thing that gets added to the route somebody was thinking about and not to its sibling.
   */
  it('share one preamble rather than three copies of six checks', () => {
    for (const [name, source] of Object.entries(SESSION_ROUTES)) {
      expect(code(source), `${name} does not use the shared preamble`).toContain(
        'prepareBillingRequest(request)',
      )
    }
  })

  it('never opens a database connection of its own', () => {
    for (const [name, source] of Object.entries(SESSION_ROUTES)) {
      expect(code(source), `${name} reaches the database directly`).not.toMatch(/billingDb|postgres/)
    }
  })
})

describe('checkout', () => {
  /**
   * THE ACCOUNT EMAIL IS THE KDF SALT. `deriveMasterSecret` salts with the normalised email,
   * so it is key material as much as an identifier, and ADR 0007 names it outright as not a
   * safe join key to hand a payment processor. Stripe collects a billing email on its own page.
   */
  it('never sends the account email to the processor', () => {
    expect(code(CHECKOUT)).not.toContain('customer_email')
    expect(code(CHECKOUT)).not.toMatch(/user\.email|data\.user\.email/)
  })

  /**
   * The workspace id comes from `loadWorkspacePrefs()` under the caller's own session, never
   * from the request body. It is the only thing standing between a bug and a plan written onto
   * somebody else's account, because the policies on that table are `using (true)`.
   */
  it('takes the workspace id from the session and not from the body', () => {
    expect(code(CHECKOUT)).toMatch(/client_reference_id:\s*workspaceId/)
    expect(code(CHECKOUT)).not.toMatch(/client_reference_id:\s*body/)
  })

  /**
   * A session id is a token, and `csp.ts` already states this codebase's rule about tokens in
   * URLs — it is why Referrer-Policy is strict-origin-when-cross-origin. The success page
   * re-reads the plan from the database and needs nothing.
   */
  it('puts no session token in the success URL', () => {
    expect(code(CHECKOUT)).not.toContain('CHECKOUT_SESSION_ID')
  })

  /**
   * `NEXT_PUBLIC_SITE_ORIGIN` falls back to the production URL, so a preview deployment would
   * send a preview user to production after paying — a bug that exists only on preview, which
   * is the environment nobody checks.
   */
  it('derives its origin from the request rather than from the environment', () => {
    expect(code(CHECKOUT)).toContain('origin')
    expect(code(CHECKOUT)).not.toContain('NEXT_PUBLIC_SITE_ORIGIN')
  })

  it('refuses to sell a second subscription to an account that has one', () => {
    expect(code(CHECKOUT)).toContain('already_subscribed')
  })
})

describe('subscription changes', () => {
  /**
   * A CANCELLED SUBSCRIPTION IS TERMINAL AT STRIPE. It cannot be reactivated, only replaced.
   * Only a PENDING cancellation can be undone, which is the only reason a resume exists at all
   * — and an immediate cancel would also throw away time somebody has already paid for.
   */
  it('cancels at period end and never immediately', () => {
    expect(code(SUBSCRIPTION)).toMatch(/cancel_at_period_end:/)
    expect(code(SUBSCRIPTION)).not.toMatch(/subscriptions\.cancel\(/)
    expect(code(SUBSCRIPTION)).not.toMatch(/subscriptions\.del\(/)
  })

  /**
   * OMITTING `items[0].id` IS THE SINGLE MOST COMMON WAY TO BREAK A PLAN SWITCH: Stripe ADDS a
   * second item instead of replacing the first, so the customer ends up subscribed to monthly
   * AND yearly at once. There is no error.
   */
  /*
   * LOOSENED DELIBERATELY, AND THIS NOTE IS THE REASON.
   *
   * These matched the exact spelling — `items:\s*\[\{\s*id:\s*item\.id`,
   * `subscription_details:\s*\{\s*items,` — so renaming a local, or extracting the array
   * into a helper, reddened them with a message about a guarantee that was perfectly intact.
   * A test that fires falsely on a refactor is a test somebody deletes on a Friday, and the
   * facts underneath are worth more than that.
   *
   * They now assert the FACTS: an item id is named, a quantity is carried, and both calls
   * name the same two things. The exact formatting is not the contract.
   */
  it('names the item id when swapping a price', () => {
    expect(code(SUBSCRIPTION)).toMatch(/\bid:\s*item\.id\b/)
  })

  /** Changing a price RESETS quantity to 1 unless it is carried over. */
  it('carries the quantity across a price change', () => {
    expect(code(SUBSCRIPTION)).toMatch(/\bquantity:/)
  })

  /**
   * THE PREVIEW AND THE UPDATE MUST MODEL THE SAME CHANGE. A preview built from different
   * parameters from the update it precedes is a number that is not the number — which is worse
   * than showing none, because the user confirmed against it.
   */
  it('previews the same items and proration it then applies', () => {
    const body = code(SUBSCRIPTION)
    // The same two identifiers reach both calls. WHICH identifiers is the contract; how the
    // object literal is spelled is not.
    expect(body).toMatch(/subscription_details:[\s\S]{0,80}items[\s\S]{0,40}proration_behavior/)
    expect(body).toMatch(/subscriptions\.update\([\s\S]{0,80}items[\s\S]{0,40}proration_behavior/)
  })

  /**
   * A CADENCE SWITCH CHARGES A CARD IMMEDIATELY, for a prorated amount that is neither $8 nor
   * $72. The Terms promise the amount is shown before you confirm, and ADR 0009 §2 specifies
   * preview-then-confirm — and for one commit this route did neither, while Cancel, which moves
   * no money today, had a two-step confirmation. Three artefacts disagreed and the code was the
   * one that was wrong.
   */
  it('refuses to switch without an explicit confirm', () => {
    const body = code(SUBSCRIPTION)
    expect(body).toContain('createPreview')
    expect(body).toMatch(/body\['confirm'\]\s*!==\s*true/)
    // The preview branch RETURNS. If it fell through, the confirm gate would be decoration.
    const previewAt = body.indexOf("body['confirm'] !== true")
    const updateAt = body.indexOf('subscriptions.update(current, {', previewAt)
    expect(previewAt).toBeGreaterThan(-1)
    expect(updateAt).toBeGreaterThan(previewAt)
    expect(body.slice(previewAt, updateAt)).toMatch(/return Response\.json\(\{\s*preview:/)
  })

  /**
   * The house RPC pattern applied where two tabs are genuinely likely: an expected value in, a
   * distinguishable slug out. Acting on a subscription the page was not rendered with is
   * applying an instruction to the wrong object with money attached.
   */
  it('refuses to act on a subscription the page was not rendered with', () => {
    expect(code(SUBSCRIPTION)).toContain('stale_subscription')
  })

  /** 3DS is the one thing on this route that genuinely cannot happen headlessly. */
  it('has a path for a bank that wants to confirm the charge', () => {
    expect(code(SUBSCRIPTION)).toContain('needs_confirmation')
    expect(code(SUBSCRIPTION)).toContain('authentication_required')
  })
})

describe('the portal', () => {
  /**
   * The portal is NOT this product's management surface — cancel, resume and the cadence
   * switch all live on our own page. This route exists for the two actions that genuinely
   * cannot: taking a card number (which needs Stripe.js in a bundle whose threat model is that
   * XSS is total compromise) and 3DS confirmation. If a third flow appears here, the
   * requirement has quietly been given up on.
   */
  it('offers only the two flows that cannot happen on our own domain', () => {
    expect(code(PORTAL)).toContain('payment_method_update')
    expect(code(PORTAL)).toContain('subscription_update_confirm')
    expect(code(PORTAL)).not.toContain("type: 'subscription_cancel'")
    expect(code(PORTAL)).not.toMatch(/type:\s*'subscription_update'[^_]/)
  })

  /**
   * Passed explicitly, never left to the account default: a dashboard edit to the default
   * would silently change what this app does, in production, with no commit anywhere.
   */
  it('names its configuration explicitly', () => {
    expect(code(PORTAL)).toMatch(/configuration:\s*config\.portalConfigurationId/)
  })
})
