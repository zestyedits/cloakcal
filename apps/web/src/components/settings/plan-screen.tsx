import {
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
import { SettingsSiblings } from './settings-doors'
import settings from './settings.module.css'
import styles from './plan.module.css'

/**
 * /settings/plan — what your account includes, what Pro will cost, and the plain statement
 * that Pro cannot be bought yet.
 *
 * THREE BANDS, IN A FIXED ORDER, AND THE ORDER IS THE POINT: Your plan, Billing, Pro.
 * "What am I on", then "where do I manage it", then "what else is there" — which is the order
 * the questions actually arrive in, and it does not change when the billing flag flips. The
 * management control used to live at the foot of Your plan while billing was off and in a band
 * of its own once it was on, so the answer to "where do I cancel" MOVED depending on a server
 * flag the reader cannot see. A band that is always in the same place, saying either "here is
 * nothing yet" or "here are your controls", is the whole reason this page has a Billing
 * heading at all.
 *
 * IT SAYS EACH THING ONCE. This page carried the "Pro cannot be bought yet" disclaimer FIVE
 * times over — the Coming soon tag, the billing note, the Pro lede, the price note and the
 * roadmap note — plus a merged pair of bands both about Pro. Every sentence was true and the
 * page was still unreadable, because a caveat repeated five times is not five times as honest,
 * it is a wall a reader skips. The facts below are the same facts; there is one copy of each.
 *
 * WIDE, unlike the other settings sub-pages, and for one reason: the billing band lays its
 * cadence cards out two up, and a 46rem measure stacks them. Every page here that is a single
 * column of form controls is narrow instead.
 *
 * A SERVER COMPONENT, unlike security-screen. Nothing here holds state, and the only
 * interactive thing is one disabled button, which is a client island of its own rendered
 * with serialisable props.
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
              <PlannedRows items={current.planned} tag />
            </div>
          )}

          {/* Rule 1, and the one place on this page that states it. A privacy product that
              overclaims is a privacy product that lies, and a pricing page is exactly
              where the temptation to round "encrypted" up to "we cannot see anything"
              lives. Two sentences rather than four: "content is encrypted in your browser"
              was the first bullet in the list directly above, and "that is true on Free and
              stays true on Pro" is what "on any plan" already says. */}
          <p className={styles.note}>
            Cloaking is not a paid feature and it will not become one, on any plan. CloakCal
            is not zero knowledge: the server stores times, durations, repeats and calendar
            names in the clear, because placing and repeating an event needs them.
          </p>
        </section>

        {/* ALWAYS RENDERED, AND ALWAYS HERE. Everything above is a description of a tier;
            everything in this band either spends money or explains why it cannot yet.
            Keeping the heading in place whichever way the flag falls is what makes "where
            do I manage my subscription" a question with one answer.

            It is also why a purchase control is never buried under the features list and the
            privacy paragraph: the banners that say "test mode" and "nothing here is real"
            have to arrive before the button, not after a screen of scrolling. */}
        <section className={settings.band}>
          <div className={settings.panelHead}>
            <h2 className={settings.panelTitle}>Billing</h2>
          </div>

          {billing !== null ? (
            <BillingBand view={billing} preview={billingPreview} checkout={checkout} />
          ) : (
            <div className={styles.billingRow}>
              {/* Disabled AND the page says why, per the rule the passkeys card states.
                  Rendered rather than omitted so the 44px sweep and the axe scan have a real
                  control to measure, and so "where do I cancel" is answered on screen
                  instead of being missing. */}
              <Button variant="outline" disabled>
                Manage billing
              </Button>
              <p className={styles.note}>
                Billing opens when sign-ups do. There is no card on file and nothing to
                cancel.
              </p>
            </div>
          )}
        </section>

      {/* `comingSoon` is "billing is off", which is the only state in which this band has
          to explain that Pro cannot be bought. It no longer gates a price, because there
          is no longer a price here to gate. */}
      <ProBand tier={pro} comingSoon={billing === null} />
      </main>

      <SettingsSiblings current="plan" billingEnabled={billing !== null} />
    </PageShell>
  )
}

/**
 * ONE BAND FOR PRO, not two. It was "Pro" (tagline, prices, a price caveat) followed
 * immediately by "What Pro will add" (the same four rows, another caveat) — two h2s, two
 * closing notes and two restatements of "none of this exists yet" about one subject. The
 * roadmap is now an h3 inside the band that names the tier it belongs to, which is what it
 * always was.
 *
 * NO PRICE HERE, IN EITHER DIRECTION, and that is the correction rather than an omission.
 * This band used to draw $8 and $72 whenever `billing === null` — which is to say the price
 * was shown in exactly the state where nobody could pay it, and hidden in the state where
 * the billing band draws the same figures as pressable controls. A number nobody can act on
 * is not information, it is an invitation to doubt the rest of the page; and the one place a
 * price belongs is on the thing that takes the money. `formatPlanPrice` and the annual
 * arithmetic still live, in `billing-band.tsx`, where the cards are buttons.
 *
 * The tier is still NAMED, and still says plainly that it is not for sale. That is the honest
 * half of what was here, and it costs nothing to keep.
 */
function ProBand({ tier, comingSoon }: { tier: PlanTier; comingSoon: boolean }) {
  // Through the exhaustive switch, so a third purchase state is a compile error here rather
  // than a tag that silently keeps saying "Coming soon" about something you can now buy.
  const label = purchaseLabel(tier.purchase)

  return (
    <section className={settings.band}>
      <div className={settings.panelHead}>
        <h2 className={settings.panelTitle}>{tier.name}</h2>
        {/*
         * THE TAG IS SUPPRESSED ONCE THE BILLING BAND IS LIVE, and it is a real contradiction
         * rather than a tidiness point. `purchase` is a fact about the CATALOG — Pro is not
         * purchasable — and it stays 'coming-soon' until somebody edits the catalog, which is
         * a separate change from switching the billing flag on. So in the shipping
         * configuration this work creates, a subscriber saw "You are on Pro. It renews on
         * 3 March." in the band above and "PRO · COMING SOON" in this one, about the thing
         * they were paying for. Found by opening a screenshot of the preview, which is the
         * only place either state is rendered.
         *
         * `purchaseLabel` is still CALLED unconditionally, so the exhaustive switch keeps
         * being the compile error it exists to be. Only the rendering is gated.
         */}
        {comingSoon && label !== null && <span className={settings.soon}>{label}</span>}
      </div>

      {/* The tagline, and the one sentence that says it is not for sale. The tag beside the
          heading has already said "Coming soon"; this says what that means for money. The
          longer version explained that the tier is "named and priced here so you can see
          where this is going", which is a sentence about why the page exists rather than
          about Pro. */}
      <p className={settings.sectionLede}>
        {tier.tagline}
        {comingSoon && ' It cannot be bought yet.'}
      </p>

      {/* An h3, so the roadmap is filed UNDER the tier it belongs to rather than competing
          with it for an h2. The count keeps the register's grammar. */}
      <div className={styles.roadmap}>
        <div className={settings.panelHead}>
          <h3 className={styles.roadmapTitle}>What {tier.name} will add</h3>
          <span className={settings.panelCount}>
            {String(tier.planned.length).padStart(2, '0')}
          </span>
        </div>

        <PlannedRows items={tier.planned} tag={false} />

        <p className={styles.note}>
          None of these exist yet, and this is not a date. Basic privacy is never paywalled:
          cloaking an event stays on the free plan.
        </p>
      </div>
    </section>
  )
}

/**
 * The roadmap rows, in the grammar the /settings footer already speaks: named, because an
 * honest roadmap is worth something, and quiet, because none of it works yet.
 *
 * One component, two callers — Free's block and Pro's band. It was the same six lines twice,
 * and in this repo the second copy is where divergence starts.
 *
 * THE TAG IS OPTIONAL, AND WHICH CALLER GETS IT IS THE WHOLE POINT. "Coming soon" is
 * information only when the row sits among things that DO exist: Free's Export row is one
 * deferred item under eight shipped bullets, so without the tag it reads as a ninth feature.
 * Pro's four rows sit under a heading that says "What Pro will add" and above a note that says
 * none of them exist yet, so the tag there was the third statement of the same fact, printed
 * four times over. Six identical badges on one screen is how a badge stops being read at all,
 * including the one that matters.
 */
function PlannedRows({ items, tag }: { items: PlanTier['planned']; tag: boolean }) {
  return (
    <>
      {items.map((item) => (
        <p key={item.name} className={styles.plannedRow}>
          <span className={styles.plannedName}>{item.name}</span>
          {tag && <span className={settings.soon}>Coming soon</span>}
          {item.detail}
        </p>
      ))}
    </>
  )
}
