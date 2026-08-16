import {
  annualMonthsFree,
  annualPerMonth,
  annualSavingPercent,
  formatPlanPrice,
  planById,
  purchaseLabel,
  type PlanId,
  type PlanTier,
} from '@/lib/plans'
import { describeBilling } from '@/lib/billing-copy'
import type { BillingView } from '@/server/billing/view'
import type { CheckoutReturn } from './billing-band'
import { PageMasthead, PageShell } from '../page-shell'
import { Button } from '../ui/button'
import { PlanBadge } from '../ui/plan-badge'
import { BillingBand } from './billing-band'
import { SettingsNav } from './settings-nav'
import settings from './settings.module.css'
import styles from './plan.module.css'

/**
 * /settings/plan — what your account includes, what Pro will cost, and the plain statement
 * that Pro cannot be bought yet.
 *
 * WIDE, and with the rail, like /settings/security: keeping the rail and swapping the panel
 * beside it is what makes a submenu part of its menu. `settings.layout` WITHOUT
 * `settings.scrollRoom` — that 45vh exists for the scrolling accordion on /settings and
 * would leave half a screen of nothing under this page's last band.
 *
 * A SERVER COMPONENT, unlike security-screen. Nothing here holds state, and the only
 * interactive things are one disabled button and the rail, both of which are client islands
 * of their own rendered with serialisable props.
 *
 * IT RENDERS IN THE DEMO, and that is a testing decision as much as an honesty one, exactly
 * as the Passkeys card is: every Playwright project runs in fixture mode, so the price cards,
 * the roadmap rows and their tokens would be measured by nothing — not the axe scan in either
 * theme, not the 44px sweep — if this page hid itself without a session.
 *
 * Two things change in the demo, and both are the same rule: a fixture has NO ACCOUNT, so it
 * cannot have a plan. The "you are on Free" sentence becomes a note saying so, and the badge
 * is not rendered at all.
 */
export function PlanScreen({
  demo,
  plan,
  billing = null,
  billingPreview = false,
  checkout = null,
}: {
  demo: boolean
  plan: PlanId
  /**
   * Null means billing is not switched on for this deployment, which is the state of every
   * environment today. THE NULL BRANCH BELOW IS UNTOUCHED JSX, so "the page is byte-identical
   * when billing is off" is a property of the diff rather than a claim, and `e2e/plan.spec.ts`
   * keeps proving it in a real browser at both breakpoints.
   */
  billing?: BillingView | null
  /** The `?billing=` preview. Inert controls, and they say so. Fixture-gated by the caller. */
  billingPreview?: boolean
  /** Where Stripe sent the user back to. Suppresses the purchase control while it settles. */
  checkout?: CheckoutReturn
}) {
  const current = planById(plan)
  // By id, NOT by `purchase === 'coming-soon'`. Selecting on the purchase state would make
  // this whole section disappear the day Pro becomes buyable — silently, with no type error
  // and no failing test, on the one screen whose job is to describe it.
  const pro = planById('pro')

  return (
    <PageShell back={{ href: '/settings', label: 'Settings' }}>
      {/* The lede said "what Pro will cost when billing opens" for as long as it could not be
          bought. That is a claim with an expiry date on a page that now sometimes takes a
          payment, so it states the durable fact instead and lets the bands say which case
          this account is in. */}
      <PageMasthead
        title="Plan"
        lede="What your account includes today, and what Pro costs."
      />

      <div className={settings.layout}>
        <SettingsNav current="plan" scope="settings" />

        <main id="main" className={settings.sections}>
          <section className={settings.band}>
            <div className={settings.panelHead}>
              <h2 className={settings.panelTitle}>Your plan</h2>
              {/* NOT rendered in the demo. A fixture has no account, so it has no plan for a
                  badge to state, and printing "Free" beside "there is no plan on file" is one
                  surface contradicting the other in the same view. The settings card reaches
                  the same conclusion by printing "Demo" instead of a tier.

                  That leaves the badge with no rendered coverage anywhere, which is a real
                  cost and the honest one: it is the same position the sidebar badge is in,
                  and it is covered the same way — colour by CONTRAST_PAIRS, where CLAUDE.md
                  says colour belongs, and structure by plan-badge.server.test.ts. */}
              {!demo && <PlanBadge plan={plan} />}
            </div>

            {/* ONE summary sentence, never two. The state-aware version wins whenever billing
                is live, because "You are on Free. Everything CloakCal does today, for one
                person." beside "Your Pro subscription ended on 3 March" is one surface
                contradicting another in the same view — the same reason the badge is
                suppressed in the demo. */}
            {billing !== null ? (
              <p className={settings.sectionLede}>
                {describeBilling(billing.state, billing.renewsOn).summary}
              </p>
            ) : demo ? (
              <p className={settings.lockedNote}>
                Demo. There is no account here, so there is no plan on file. What follows is
                what a real account gets.
              </p>
            ) : (
              <p className={settings.sectionLede}>
                You are on {current.name}. {current.tagline}
              </p>
            )}

            <ul className={styles.includes}>
              {current.includes.map((item) => (
                <li key={item} className={styles.includeRow}>
                  {item}
                </li>
              ))}
            </ul>

            {/* What is coming to THIS tier, in the same quiet roadmap grammar Pro uses
                below. It renders here rather than being left in the data unread, because
                the two things in it are both promises worth being held to: passkeys are
                built and waiting on a migration, and Export is the commitment that this
                product will never charge you to leave. */}
            {current.planned.length > 0 && (
              <div className={styles.plannedBlock}>
                <PlannedRows items={current.planned} />
              </div>
            )}

            {/* Rule 1, stated the way the landing page states it. A privacy product that
                overclaims is a privacy product that lies, and a pricing page is exactly
                where the temptation to round "encrypted" up to "we cannot see anything"
                lives. */}
            <p className={styles.note}>
              Cloaking is not a paid feature and it will not become one. Event content is
              encrypted in your browser on every plan. CloakCal is not zero knowledge: the
              server stores times, durations, repeats and which calendar an event is on in
              the clear, because reminders and conflict detection need them. That is true on
              Free, and it stays true on Pro.
            </p>

            {billing === null && (
              <div className={styles.billingRow}>
                {/* Disabled AND the page says why, per the rule the passkeys card states.
                    Rendered rather than omitted so the 44px sweep and the axe scan have a real
                    control to measure, and so "where do I cancel" is answered on screen
                    instead of being missing. */}
                <Button variant="outline" disabled>
                  Manage billing
                </Button>
                <p className={styles.note}>
                  Billing opens when sign-ups do. There is no card on file, no payment company
                  connected to this account, and nothing to cancel.
                </p>
              </div>
            )}
          </section>

          {/* ITS OWN BAND, not a row at the foot of "Your plan". Everything above is a
              description of a tier; everything in here can spend money. Burying a purchase
              control under a features list and a privacy paragraph means the two banners that
              say "test mode" and "nothing here is real" arrive after a screen of scrolling,
              which is exactly where a warning stops being read. */}
          {billing !== null && (
            <section className={settings.band}>
              <div className={settings.panelHead}>
                <h2 className={settings.panelTitle}>Billing</h2>
              </div>
              <BillingBand view={billing} preview={billingPreview} checkout={checkout} />
            </section>
          )}

          {/* Pro's own price band is suppressed once billing is live, because the band above
              has already drawn the price cards as a CONTROL. Two copies of $8 and $72 on one
              page, one pressable and one not, is a page where somebody presses the wrong one.
              The "what Pro will add" roadmap survives either way — it is the disclosure the
              entitlement map is checked against. */}
          <ProBand tier={pro} showPricing={billing === null} />
        </main>
      </div>
    </PageShell>
  )
}

function ProBand({ tier, showPricing }: { tier: PlanTier; showPricing: boolean }) {
  const price = tier.price
  if (price === null) return null

  const monthsFree = annualMonthsFree(price)
  // Through the exhaustive switch, so a third purchase state is a compile error here rather
  // than a tag that silently keeps saying "Coming soon" about something you can now buy.
  const label = purchaseLabel(tier.purchase)

  return (
    <>
      {showPricing && (
      <section className={settings.band}>
        <div className={settings.panelHead}>
          <h2 className={settings.panelTitle}>{tier.name}</h2>
          {label !== null && <span className={settings.soon}>{label}</span>}
        </div>

        <p className={settings.sectionLede}>
          {tier.tagline} It is named and priced here so you can see where this is going. It
          cannot be bought yet, and nothing on this page will take a payment.
        </p>

        {/* Stacked cards, not a table. See plan.module.css. */}
        <div className={styles.priceGrid}>
          <div className={styles.priceCard}>
            <h3 className={styles.priceTerm}>Monthly</h3>
            <p className={styles.priceAmount}>
              {formatPlanPrice(price, 'monthly')}
              <span className={styles.pricePer}>a month</span>
            </p>
            <p className={styles.priceNote}>Billed every month.</p>
          </div>

          {/* Better value said three ways and never by colour alone: the flag word, the
              arithmetic in the note, and the accent edge. */}
          <div className={styles.priceCard} data-best="true">
            <h3 className={styles.priceTerm}>
              Yearly
              <span className={styles.priceFlag}>Better value</span>
            </h3>
            <p className={styles.priceAmount}>
              {formatPlanPrice(price, 'annual')}
              <span className={styles.pricePer}>a year</span>
            </p>
            <p className={styles.priceNote}>
              That works out at {annualPerMonth(price)} a month, so {monthsFree} months free.
              Save {annualSavingPercent(price)} percent against paying monthly.
            </p>
          </div>
        </div>

        <p className={styles.note}>
          Prices are in US dollars. They are what we plan to charge rather than a quote:
          nothing can be bought yet, and if they change before billing opens, this page
          changes with them.
        </p>
      </section>
      )}

      <section className={settings.band}>
        <div className={settings.panelHead}>
          <h2 className={settings.panelTitle}>What {tier.name} will add</h2>
          <span className={settings.panelCount}>
            {String(tier.planned.length).padStart(2, '0')}
          </span>
        </div>

        <PlannedRows items={tier.planned} />

        <p className={styles.note}>
          None of these exist yet. This is what {tier.name} is for, not a date. Basic privacy
          is never paywalled: cloaking an event stays on the free plan.
        </p>
      </section>
    </>
  )
}

/**
 * The roadmap rows, in the grammar the /settings footer already speaks: named, because an
 * honest roadmap is worth something, and quiet, because none of it works yet.
 *
 * One component, two callers — Free's block and Pro's band. It was the same six lines twice,
 * and in this repo the second copy is where divergence starts.
 */
function PlannedRows({ items }: { items: PlanTier['planned'] }) {
  return (
    <>
      {items.map((item) => (
        <p key={item.name} className={styles.plannedRow}>
          <span className={styles.plannedName}>{item.name}</span>
          <span className={settings.soon}>Coming soon</span>
          {item.detail}
        </p>
      ))}
    </>
  )
}
