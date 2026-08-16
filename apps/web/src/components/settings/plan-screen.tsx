import {
  annualMonthsFree,
  annualPerMonth,
  annualSavingPercent,
  formatPlanPrice,
  planById,
  type PlanId,
  type PlanTier,
} from '@/lib/plans'
import { PageMasthead, PageShell } from '../page-shell'
import { Button } from '../ui/button'
import { PlanBadge } from '../ui/plan-badge'
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
 * IT RENDERS THE SAME IN THE DEMO, and that is a testing decision as much as an honesty one,
 * exactly as the Passkeys card is. Every Playwright project runs in fixture mode, so the
 * badge, the price cards and their tokens would be measured by nothing — not the axe scan,
 * not the 44px sweep — if this page hid itself without a session. The one thing that changes
 * is the sentence about YOUR plan, because a fixture has no account to have one.
 */
export function PlanScreen({ demo, plan }: { demo: boolean; plan: PlanId }) {
  const current = planById(plan)
  // By id, NOT by `purchase === 'coming-soon'`. Selecting on the purchase state would make
  // this whole section disappear the day Pro becomes buyable — silently, with no type error
  // and no failing test, on the one screen whose job is to describe it.
  const pro = planById('pro')

  return (
    <PageShell back={{ href: '/settings', label: 'Settings' }}>
      <PageMasthead
        title="Plan"
        lede="What your account includes today, and what Pro will cost when billing opens."
      />

      <div className={settings.layout}>
        <SettingsNav current="plan" scope="settings" />

        <main id="main" className={settings.sections}>
          <section className={settings.band}>
            <div className={settings.panelHead}>
              <h2 className={settings.panelTitle}>Your plan</h2>
              {/* Rendered in the demo too. It is labelling the plan being described, which
                  is true whether or not anyone is signed in. */}
              <PlanBadge plan={plan} />
            </div>

            {demo ? (
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
                {current.planned.map((item) => (
                  <p key={item.name} className={styles.plannedRow}>
                    <span className={styles.plannedName}>{item.name}</span>
                    <span className={settings.soon}>Coming soon</span>
                    {item.detail}
                  </p>
                ))}
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
          </section>

          <ProBand tier={pro} />
        </main>
      </div>
    </PageShell>
  )
}

function ProBand({ tier }: { tier: PlanTier }) {
  const price = tier.price
  if (price === null) return null

  const monthsFree = annualMonthsFree(price)

  return (
    <>
      <section className={settings.band}>
        <div className={settings.panelHead}>
          <h2 className={settings.panelTitle}>{tier.name}</h2>
          <span className={settings.soon}>Coming soon</span>
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

      <section className={settings.band}>
        <div className={settings.panelHead}>
          <h2 className={settings.panelTitle}>What {tier.name} will add</h2>
          <span className={settings.panelCount}>
            {String(tier.planned.length).padStart(2, '0')}
          </span>
        </div>

        {/* The roadmap grammar the settings footer already speaks: named, because an honest
            roadmap is worth something, and quiet, because none of it works. */}
        {tier.planned.map((item) => (
          <p key={item.name} className={styles.plannedRow}>
            <span className={styles.plannedName}>{item.name}</span>
            <span className={settings.soon}>Coming soon</span>
            {item.detail}
          </p>
        ))}

        <p className={styles.note}>
          None of these exist yet. This is what {tier.name} is for, not a date. Basic privacy
          is never paywalled: cloaking an event stays on the free plan.
        </p>
      </section>
    </>
  )
}
