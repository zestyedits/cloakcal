'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { billingErrorMessage } from '@/lib/billing-error'
import { canManage, canPurchase, describeBilling } from '@/lib/billing-copy'
import {
  annualMonthsFree,
  annualPerMonth,
  annualSavingPercent,
  formatPlanPrice,
  planById,
  type PlanCadence,
} from '@/lib/plans'
import type { BillingView } from '@/server/billing/view'
import { Button } from '../ui/button'
import { InlineError } from '../ui/inline-error'
import plan from './plan.module.css'
import styles from './billing.module.css'

/**
 * THE ONE INTERACTIVE ISLAND ON /settings/plan.
 *
 * `plan-screen.tsx` stays a server component — it renders a catalog, a roadmap and an honesty
 * paragraph, none of which hold state — and hands this the whole `BillingView` as serialisable
 * props. That keeps the Stripe SDK, `server/billing/view.ts` and every secret it reads out of
 * the client bundle entirely: this file imports the VIEW TYPE and nothing else from the server.
 *
 * WHY THIS EXISTS AT ALL, given Stripe ships a Billing Portal that does the same job. The
 * portal is a redirect to a Stripe-hosted page and cannot be iframed, so it fails the
 * requirement outright. Cancel, resume and switch are Subscriptions API calls from our own
 * route handler instead. The single action that genuinely cannot happen here is taking a card
 * number, which needs Stripe.js in a bundle whose whole threat model is that XSS equals total
 * compromise — so that one is a portal deep link and `csp.ts` never changes. ADR 0009 §2.
 *
 * NOTHING IS OPTIMISTIC, AND THAT IS NOT LAZINESS. Only `billing_writer` may write
 * `subscriptions`, and it only runs in the webhook, so this component cannot update our own
 * row and must not pretend to. `router.refresh()` re-runs the server component, which re-reads
 * Stripe, which is already the truth — no local override, nothing to reconcile, and no flicker
 * back to the old value a second later when the webhook lands. The natural instinct on a
 * billing screen is to set state from the response; do not.
 *
 * WE NAVIGATE WITH `window.location.href`, NEVER A FORM POST. `form-action 'self'` is enforced
 * against redirect TARGETS in Chrome and Safari, so a form that 303s to checkout.stripe.com is
 * blocked — and blocked in PRODUCTION ONLY, because the dev policy is looser and every
 * Playwright project takes the dev-unlock early return. That is the /opengraph-image profile
 * exactly: the one environment nothing runs in is the only one that behaves differently. A
 * script-initiated top-level navigation is governed by no CSP directive at all.
 */

/** Only these two hosts, checked here as well as on the server. */
const STRIPE_HOSTS = new Set(['checkout.stripe.com', 'billing.stripe.com'])

/**
 * An open redirect out of our own JSON would be a convincing phishing hop: a link on our
 * domain, clicked by somebody who has just decided to type a card number. `auth/callback`
 * guards its `?next=` by hand for the same reason. Checked on both sides deliberately, since
 * the server is where the rule matters and the client is where it is cheap.
 */
function isStripeUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && STRIPE_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

type Action = 'checkout' | 'cancel' | 'resume' | 'switch' | 'card'

/** What Stripe sent us back to, if anything. Read on the server, passed in as a prop. */
export type CheckoutReturn = 'done' | 'cancelled' | null

export function BillingBand({
  view,
  preview,
  checkout = null,
}: {
  view: BillingView
  preview: boolean
  checkout?: CheckoutReturn
}) {
  const router = useRouter()
  const pro = planById('pro')
  const price = pro.price

  const [cadence, setCadence] = useState<PlanCadence>('annual')
  const [busy, setBusy] = useState<Action | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /**
   * ONE PENDING CONFIRMATION, NEVER TWO, AND THAT IS WHY THIS IS A UNION.
   *
   * It was `confirmingCancel: boolean` plus `proposal: {…} | null`, two independent pieces of
   * state — so pressing "Switch to yearly" and then "Cancel Pro" rendered BOTH panels at once:
   * "This charges you $64.20 today" stacked above "Cancel Pro?", with two live confirm buttons
   * on a screen about money. Neither e2e test saw it, because each opened one panel alone.
   *
   * The same split left a second defect. `post()` never cleared `proposal`, so after a
   * SUCCESSFUL switch the panel stayed up still offering to make the change that had just been
   * made — `router.refresh()` re-runs the server component but preserves client state.
   * Ironically a consequence of this file's own "do not set state from the response" rule,
   * applied to server state and then forgotten for local UI state.
   *
   * As one discriminated union both are unrepresentable rather than merely fixed, and a
   * boolean disappears.
   *
   * The `switch` variant carries WHAT IT WOULD COST, fetched before anything is charged. If the
   * preview fails this stays null and no confirm button is drawn at all: refusing to switch
   * blind is the point.
   */
  const [pending, setPending] = useState<
    | { kind: 'cancel' }
    | {
        kind: 'switch'
        cadence: PlanCadence
        amount: string
        charges: boolean
        credit: string | null
      }
    | null
  >(null)

  const copy = describeBilling(view.state, view.renewsOn)

  /*
   * THE DOUBLE-PURCHASE WINDOW, AND IT WAS OPEN.
   *
   * `success_url` has always been `?checkout=done`, and until this line NOTHING READ IT. So
   * somebody returning from a successful Stripe checkout before the webhook landed saw the
   * ordinary Free screen — "Continue to Stripe" still rendered, still enabled — because our own
   * row is written by `billing_writer` in the webhook and cannot possibly be current yet.
   *
   * Pressing it again was not harmless. The guard in `checkout/route.ts` keys off
   * `providerSubscriptionId`, which is still null, so it would let a second session through;
   * `customer` is only passed when we already have one, so Stripe would create a SECOND
   * customer; the upsert overwrites both provider ids unconditionally, so the row would forget
   * the first subscription; and every later event for it would take the `unknown-customer`
   * branch and log a warning nobody reads. Charged twice, with one of the two invisible in the
   * product and uncancellable from it.
   *
   * Suppressing the control for this one render is the cheap half of the fix. The route-side
   * half is the `already_subscribed` guard, which only starts working once the webhook lands.
   */
  const settling = checkout === 'done' && view.plan !== 'pro'

  const purchasable = canPurchase(view.state) && price !== null && !settling
  // TWO GATES, and the second is the one that matters: a granted account has `plan === 'pro'`
  // and no subscription to act on, so a Cancel button here would post a null id and 500 on an
  // account that never paid. `canManage` alone would let it through.
  const manageable = canManage(view.state) && view.subscriptionId !== null

  /** Preview mode answers rather than acting. A button that silently does nothing is a lie. */
  const inert = (): boolean => {
    if (!preview) return false
    setError(null)
    setNotice('Preview only. Nothing was sent.')
    return true
  }

  async function post(action: Action, path: string, body: Record<string, unknown>) {
    if (inert()) return
    setBusy(action)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch(path, {
        method: 'POST',
        // Required by the routes, and it is half the CSRF defence: a cross-site HTML form
        // cannot set this header, and the Supabase session cookie is SameSite=Lax.
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload: unknown = await response.json().catch(() => null)
      const data = (payload ?? {}) as { url?: unknown; error?: unknown }

      if (!response.ok) {
        setError(billingErrorMessage(data.error))
        setBusy(null)
        return
      }

      // A redirect answer. Validated before it is followed, on both sides.
      if (data.url !== undefined) {
        if (!isStripeUrl(data.url)) {
          setError(billingErrorMessage('provider_unavailable'))
          setBusy(null)
          return
        }
        window.location.href = data.url
        return
      }

      // An in-app answer. Re-read rather than patch: the server re-asks Stripe and gets the
      // truth, which our own row does not hold yet.
      //
      // The panel is CLOSED here. `router.refresh()` re-runs the server component and preserves
      // client state, so without this a completed switch leaves its own confirmation up, still
      // saying "this charges you $64.20 today" with a live button.
      setPending(null)
      router.refresh()
      setBusy(null)
    } catch {
      // A thrown fetch is a network failure, which is exactly the case where we must not
      // imply the action succeeded and must not imply it failed cleanly either.
      setError(billingErrorMessage('provider_unavailable'))
      setBusy(null)
    }
  }

  /** Step one of the switch: ask what it costs. Charges nothing and changes nothing. */
  async function previewSwitch(target: PlanCadence) {
    /*
     * THE PREVIEW MODE STILL SHOWS THE SECOND STEP, unlike every other action here, and the
     * difference is deliberate. Everything else answers "nothing was sent" because pressing it
     * is the whole interaction. This one has a SECOND SCREEN behind it — the one carrying the
     * real amount and the confirm button — and stopping at step one would leave that screen
     * exactly as unreachable as it was before this file existed: no axe run, no 44px sweep, no
     * 390px guard. Same reasoning as the `?billing=` preview itself, one level down.
     *
     * The figures are fabricated and the CONFIRM is still inert, which is what keeps this
     * honest: nothing is fetched and nothing can be sent.
     */
    if (preview) {
      setError(null)
      setNotice(null)
      setPending({
        kind: 'switch',
        cadence: target,
        amount: target === 'annual' ? '$64.20' : '$0',
        charges: target === 'annual',
        credit: target === 'annual' ? null : '$52.40',
      })
      return
    }
    setBusy('switch')
    setError(null)
    setNotice(null)
    setPending(null)
    try {
      const response = await fetch('/api/billing/subscription', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          intent: 'switch',
          cadence: target,
          confirm: false,
          subscriptionId: view.subscriptionId,
        }),
      })
      const payload: unknown = await response.json().catch(() => null)
      const data = (payload ?? {}) as {
        error?: unknown
        preview?: { amount?: unknown; charges?: unknown; credit?: unknown }
      }

      if (!response.ok || data.preview === undefined) {
        // No proposal, so no confirm button. "We could not work out what this would cost" is a
        // better outcome than a switch nobody priced.
        setError(
          response.ok
            ? 'We could not work out what this would cost. Nothing has changed. Try again in a minute.'
            : billingErrorMessage(data.error),
        )
        setBusy(null)
        return
      }

      setPending({
        kind: 'switch',
        cadence: target,
        amount: String(data.preview.amount ?? ''),
        charges: data.preview.charges === true,
        credit: typeof data.preview.credit === 'string' ? data.preview.credit : null,
      })
      setBusy(null)
    } catch {
      setError(billingErrorMessage('provider_unavailable'))
      setBusy(null)
    }
  }

  const other: PlanCadence = view.cadence === 'annual' ? 'monthly' : 'annual'
  const wordFor = (cadence: PlanCadence) => (cadence === 'annual' ? 'yearly' : 'monthly')

  return (
    <div className={styles.band} data-billing={view.state}>
      {preview && (
        <p className={styles.previewNote}>
          Billing preview. This is a demonstration of what a real account sees. Nothing here is
          connected to a payment company, and no button below sends anything.
        </p>
      )}

      {/*
        THE TEST MODE BANNER, drawn with --status-warning as a BORDER and never as ink. There
        is no --status-warning-text token, and a colour checked as a shape at 3:1 and then used
        as 12px text has now shipped an AA failure in this repo three times. The words carry
        the meaning; the edge is decoration.
      */}
      {view.mode === 'test' && (purchasable || manageable) && (
        <p className={styles.testNote}>
          Billing is in test mode. This will not charge a real card, and a real card will be
          declined. It is here so the flow can be checked, not so anything can be bought.
        </p>
      )}

      {/* Rendered as a plain note and never as a toast: a message about money must not be
          dismissible by a timer. Neither branch grants anything — `settling` only ever REMOVES
          a control. */}
      {settling && (
        <p className={styles.testNote} role="status">
          Payment received. Stripe has it, and Pro is being switched on. This usually takes a
          few seconds. Reload the page if it has not appeared in a minute, and do not pay
          again.
        </p>
      )}
      {checkout === 'cancelled' && (
        <p className={styles.notice} role="status">
          You stopped before paying. Nothing was charged.
        </p>
      )}

      {/* `copy.summary` is NOT rendered here. It heads the "Your plan" band instead, where a
          reader looks for "what am I on", and printing it twice on one page would be two
          sentences to keep in step. This band gets `copy.detail`, which is the consequence. */}
      {view.stale && (
        <p className={plan.note}>
          These details come from our own records because we could not reach Stripe just now.
          They may be a few minutes behind.
        </p>
      )}

      {manageable && (
        <dl className={styles.facts}>
          {view.cadence !== null && price !== null && (
            <Fact label="Billing">
              {formatPlanPrice(price, view.cadence)}{' '}
              {view.cadence === 'annual' ? 'a year' : 'a month'}
            </Fact>
          )}
          {view.renewsOn !== null && (
            <Fact label={view.cancelAtPeriodEnd ? 'Pro until' : 'Next payment'}>
              {view.renewsOn}
            </Fact>
          )}
          <Fact label="Card">{view.cardSummary ?? 'On file at Stripe'}</Fact>
        </dl>
      )}

      {copy.detail !== null && <p className={plan.note}>{copy.detail}</p>}

      <InlineError>{error}</InlineError>
      {notice !== null && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}

      {purchasable && price !== null && (
        <fieldset className={styles.cadence}>
          {/*
            THE CADENCE CHOICE IS THE PRICE CARDS THEMSELVES, not a select above a generic
            button. A control that says "continue" beside two prices, with the choice made
            somewhere else on the page, is a control whose AMOUNT is ambiguous at the moment of
            pressing, and that is the one moment ambiguity is expensive.
          */}
          <legend className={styles.cadenceLegend}>How would you like to pay?</legend>

          <div className={plan.priceGrid}>
            <CadenceCard
              cadence="monthly"
              term="Monthly"
              amount={formatPlanPrice(price, 'monthly')}
              per="a month"
              note="Billed every month. Cancel from this page any time."
              checked={cadence === 'monthly'}
              disabled={busy !== null}
              onSelect={setCadence}
            />
            <CadenceCard
              cadence="annual"
              term="Yearly"
              flag="Better value"
              amount={formatPlanPrice(price, 'annual')}
              per="a year"
              note={`That works out at ${annualPerMonth(price)} a month, so ${annualMonthsFree(price)} months free. Save ${annualSavingPercent(price)} percent against paying monthly.`}
              checked={cadence === 'annual'}
              disabled={busy !== null}
              onSelect={setCadence}
            />
          </div>
        </fieldset>
      )}

      <div className={styles.actions}>
        {purchasable && (
          <>
            {/*
              "Continue to Stripe", never "Upgrade", "Subscribe" or "Buy". It says what
              actually happens next, which is that you leave this site and land on somebody
              else's page. A button that hides a navigation is a button people press twice.
            */}
            <Button
              busy={busy === 'checkout'}
              aria-describedby="billing-checkout-note"
              onClick={() => void post('checkout', '/api/billing/checkout', { cadence })}
            >
              {busy === 'checkout' ? 'Opening Stripe' : 'Continue to Stripe'}
            </Button>
            <p id="billing-checkout-note" className={plan.note}>
              Stripe takes the payment and holds the card. Your card number never reaches
              CloakCal. After this you can cancel, or switch between monthly and yearly, from
              this page without going back to Stripe.
            </p>
          </>
        )}

        {manageable && pending === null && (
          <>
            {view.state === 'cancelling' ? (
              <>
                {/* "Keep Pro", not "Resume" or "Reactivate": it describes the outcome from
                    where the user is standing, which is still inside Pro. */}
                <Button
                  busy={busy === 'resume'}
                  onClick={() =>
                    void post('resume', '/api/billing/subscription', {
                      intent: 'resume',
                      subscriptionId: view.subscriptionId,
                    })
                  }
                >
                  {busy === 'resume' ? 'Keeping Pro' : 'Keep Pro'}
                </Button>
                {/* The card stays manageable during a notice period. A card that expires
                    before the paid-for period ends is still a real problem, and the person
                    least likely to be watching for it is the one who has already cancelled. */}
                <Button
                  variant="outline"
                  busy={busy === 'card'}
                  onClick={() =>
                    void post('card', '/api/billing/portal', { flow: 'payment_method' })
                  }
                >
                  Update payment method
                </Button>
                <p className={plan.note}>
                  Keeping Pro costs nothing today. Your next payment goes back to being
                  {view.renewsOn === null ? ' its usual date.' : ` due on ${view.renewsOn}.`}
                </p>
              </>
            ) : (
              <>
                {/* No cadence switch while a payment is failing: a proration that charges a
                    card Stripe is already unable to take is a second failure, not a fix. */}
                {view.state === 'active' && view.cadence !== null && (
                  <Button
                    variant="outline"
                    busy={busy === 'switch'}
                    onClick={() => void previewSwitch(other)}
                  >
                    Switch to {other === 'annual' ? 'yearly' : 'monthly'}
                  </Button>
                )}

                <Button
                  variant="outline"
                  busy={busy === 'card'}
                  onClick={() =>
                    void post('card', '/api/billing/portal', { flow: 'payment_method' })
                  }
                >
                  Update payment method
                </Button>

                {/* The TRIGGER is quiet. The filled danger colour is spent on the confirm
                    inside the confirmation, exactly as delete-event.tsx does it. */}
                <Button variant="outline" onClick={() => setPending({ kind: 'cancel' })}>
                  Cancel Pro
                </Button>
              </>
            )}
          </>
        )}
      </div>

      {/*
        STEP TWO OF THE SWITCH: the actual number, then confirm. It only exists once a preview
        has come back, so a failed preview offers no way to proceed.
      */}
      {manageable && pending?.kind === 'switch' && (
        <div
          className={styles.confirm}
          role="group"
          aria-label={`Confirm switching to ${wordFor(pending.cadence)} billing`}
        >
          <p className={styles.confirmQuestion}>
            Switch to {wordFor(pending.cadence)} billing?
          </p>
          <p className={plan.note}>
            {pending.charges
              ? `This charges you ${pending.amount} today, worked out for the time you have already paid for.`
              : 'There is nothing to pay today.'}{' '}
            {pending.credit !== null &&
              `The ${pending.credit} you have already paid for stays on your account as credit against your next invoice, rather than coming back to your card. `}
            After that you are billed{' '}
            {price !== null && formatPlanPrice(price, pending.cadence)}{' '}
            {pending.cadence === 'annual' ? 'a year' : 'a month'}.
          </p>
          <div className={styles.confirmActions}>
            {/* The safe choice first, same rule as the cancel confirmation. */}
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => {
                setPending(null)
                setError(null)
              }}
            >
              Keep {wordFor(view.cadence ?? other)}
            </Button>
            <Button
              size="sm"
              busy={busy === 'switch'}
              onClick={() =>
                void post('switch', '/api/billing/subscription', {
                  intent: 'switch',
                  cadence: pending.cadence,
                  confirm: true,
                  subscriptionId: view.subscriptionId,
                })
              }
            >
              {busy === 'switch' ? 'Switching' : `Switch to ${wordFor(pending.cadence)}`}
            </Button>
          </div>
        </div>
      )}

      {manageable && view.state !== 'cancelling' && pending?.kind === 'cancel' && (
        <div className={styles.confirm} role="group" aria-label="Confirm cancelling Pro">
          <p className={styles.confirmQuestion}>Cancel Pro?</p>
          <p className={plan.note}>
            {view.renewsOn === null
              ? 'You keep Pro until the end of the period you have already paid for. After that the account goes back to Free.'
              : `You keep Pro until ${view.renewsOn}, which you have already paid for. After that the account goes back to Free.`}{' '}
            Your calendar, your events, your contacts and your rules all stay. Nothing is
            deleted and nothing is hidden.
          </p>
          <div className={styles.confirmActions}>
            {/* Safe choice first, so the destructive button is never where the cursor is. */}
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => {
                setPending(null)
                setError(null)
              }}
            >
              Keep Pro
            </Button>
            <Button
              variant="danger"
              size="sm"
              busy={busy === 'cancel'}
              onClick={() =>
                void post('cancel', '/api/billing/subscription', {
                  intent: 'cancel',
                  subscriptionId: view.subscriptionId,
                })
              }
            >
              {busy === 'cancel' ? 'Cancelling' : 'Cancel Pro'}
            </Button>
          </div>
        </div>
      )}

      {view.invoices.length > 0 && (
        <div className={styles.invoices}>
          <h3 className={styles.invoicesTitle}>Invoices</h3>
          {/* A stacked list, not a table, for the reason plan.module.css already gives about
              the price cards: a table hands a phone a row of columns it cannot narrow. */}
          <ul className={styles.invoiceList}>
            {view.invoices.map((invoice) => (
              <li key={invoice.id} className={styles.invoiceRow}>
                <span className={styles.invoiceDate}>{invoice.date}</span>
                <span className={styles.invoiceAmount}>{invoice.amount}</span>
                <span className={styles.invoiceStatus}>{invoice.paid ? 'Paid' : 'Unpaid'}</span>
                {invoice.url !== null && (
                  <a
                    className={styles.invoiceLink}
                    href={invoice.url}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    View
                    <span className={styles.visuallyHidden}>
                      {' '}
                      the invoice from {invoice.date}, opens at Stripe
                    </span>
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.fact}>
      <dt className={styles.factLabel}>{label}</dt>
      <dd className={styles.factValue}>{children}</dd>
    </div>
  )
}

function CadenceCard({
  cadence,
  term,
  flag,
  amount,
  per,
  note,
  checked,
  disabled,
  onSelect,
}: {
  cadence: PlanCadence
  term: string
  flag?: string
  amount: string
  per: string
  note: string
  checked: boolean
  disabled: boolean
  onSelect: (cadence: PlanCadence) => void
}) {
  return (
    /* A <label> wrapping a real radio, so the whole card is the target and the browser gives
       us keyboard behaviour, the accessible name and the group semantics for free. The card
       is already well over 44px and already survives 390px through .priceGrid's
       minmax(0, 1fr) plus .priceCard's min-width: 0 — both still load-bearing. */
    <label className={`${plan.priceCard} ${styles.cadenceCard}`} data-best={flag !== undefined}>
      <input
        className={styles.cadenceInput}
        type="radio"
        name="billing-cadence"
        value={cadence}
        checked={checked}
        disabled={disabled}
        onChange={() => onSelect(cadence)}
      />
      <span className={plan.priceTerm}>
        {term}
        {flag !== undefined && <span className={plan.priceFlag}>{flag}</span>}
      </span>
      <span className={plan.priceAmount}>
        {amount}
        <span className={plan.pricePer}>{per}</span>
      </span>
      <span className={plan.priceNote}>{note}</span>
    </label>
  )
}
