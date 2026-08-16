'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import type { VisibilityRule } from '@cloakcal/policy'
import type { RedactedPage } from '@/server/audience'
import type { CalendarPrefs, SettingsCalendar } from '@/server/settings'
import type { AudienceOption } from '@/lib/audiences'
import { VIEW_LABELS } from '@/lib/calendar-views'
import { SECTIONS } from '@/lib/settings-sections'
import { planById, type PlanId } from '@/lib/plans'
import { SettingsNav, useVisibleSection } from './settings-nav'
import { CloakProvider, type ExtraSealedField } from '../cloak-provider'
import { PageMasthead, PageShell } from '../page-shell'
import { SignOutButton } from '../sign-out-button'
import { ButtonLink } from '../ui/button'
import { AppearanceSection } from './appearance-section'
import { TimeRegionSection } from './time-region-section'
import { CalendarsSection } from './calendars-section'
import { VisibilitySection } from './visibility-section'
import styles from './settings.module.css'

/**
 * The settings shell: one scrollable page, anchored sections, a chip nav that becomes a
 * rail at 768px. Sections own their controls; this file owns the hierarchy — exactly one
 * h1, one h2 per section, and the order (frequency of use first, destructive and deferred
 * last).
 *
 * Everything sealed on this page — calendar names, contact names, group labels — is opened
 * through the same CloakProvider the calendar uses. The page prop it requires is synthesised
 * here with no occurrences: settings has no events, but it has ciphertext, and the provider
 * is the one door into the store.
 */

/** The card's middle line, from the one list that owns names and descriptions. */
/** Stable identity so the observer effect does not re-subscribe on every render. */
const SECTION_IDS = SECTIONS.map((section) => section.id)

const describe = (id: string): string =>
  SECTIONS.find((section) => section.id === id)?.description ?? ''

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * One collapsible section card, on native <details> — keyboard and screen-reader
 * behaviour for free, and a closed page that reads as a table of contents instead of a
 * wall of controls. The summary row carries the title AND the current state ("Eastern
 * Time · weeks start Sunday"), so most visits never need to open anything.
 *
 * The h2 lives INSIDE the summary: it stays visible when the card is closed, so the
 * heading-order test and the section nav both keep working.
 */
function SettingsSection({
  id,
  title,
  description,
  state,
  open,
  onOpen,
  children,
}: {
  id: string
  title: string
  /** What the card is FOR — the middle level of the closed row's three. */
  description: string
  /** Plain-language current value shown while closed. */
  state: string
  /** Controlled: the page opens ONE band at a time (see openSection). */
  open: boolean
  onOpen: (next: boolean) => void
  children: ReactNode
}) {
  return (
    <details
      id={id}
      className={styles.section}
      open={open}
      /* onToggle, not onClick: `details` also opens from the keyboard, from find-in-page
         and from a `#hash`, and a click handler would miss all three. */
      onToggle={(event) => onOpen(event.currentTarget.open)}
    >
      <summary className={styles.summary}>
        <span className={styles.summaryText}>
          <h2 className={styles.sectionTitle}>{title}</h2>
          <span className={styles.sectionDescription}>{description}</span>
        </span>
        <span className={styles.summaryState}>{state}</span>
        {/* A drawn mark, not the literal "›" character this used to be: a glyph's size,
            weight and optical centre are whatever the font hands you, and the display face
            here is not the one that was drawing it. */}
        <svg
          className={styles.summaryChevron}
          viewBox="0 0 12 12"
          width="12"
          height="12"
          aria-hidden="true"
          focusable="false"
        >
          <path
            d="M4.5 2.5 L8 6 L4.5 9.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </summary>
      <div className={styles.sectionBody}>{children}</div>
    </details>
  )
}

/**
 * A `#section` link must OPEN the card it points at, not scroll to a closed row.
 *
 * Also reports which id the hash names, so the rail can mark it. The rail had no active
 * state at all: seven identical chips, none of which said where you were or where you had
 * just been sent.
 */
function useOpenOnHash(): string | null {
  const [current, setCurrent] = useState<string | null>(null)

  useEffect(() => {
    const openTarget = () => {
      const id = window.location.hash.slice(1)
      setCurrent(id === '' ? null : id)
      if (id === '') return
      const target = document.getElementById(id)
      if (target instanceof HTMLDetailsElement) target.open = true
    }
    openTarget()
    window.addEventListener('hashchange', openTarget)
    return () => window.removeEventListener('hashchange', openTarget)
  }, [])

  return current
}

/** Serializable throughout: this crosses the RSC boundary. Maps arrive as plain records. */
export interface SettingsProps {
  readonly email: string
  readonly fixtureMode: boolean
  /** Display preferences, from the workspace row or from the demo cookie. */
  readonly prefs: CalendarPrefs | null
  /** Null in the demo and for a signed-in user with no workspace yet: nothing to write to. */
  readonly workspaceId: string | null
  readonly calendars: readonly SettingsCalendar[]
  readonly audiences: readonly AudienceOption[]
  readonly workspaceRules: readonly VisibilityRule[]
  readonly groupsByContact: Readonly<Record<string, readonly string[]>>
  /** The tier this account is on. Free unless a `subscriptions` row says otherwise (0024). */
  readonly plan: PlanId
  /** One line for the availability card's closed state, already formatted by the server. */
  readonly availability: string
}

export function SettingsScreen({
  email,
  fixtureMode,
  prefs,
  workspaceId,
  calendars,
  audiences,
  workspaceRules,
  groupsByContact,
  plan,
  availability,
}: SettingsProps) {
  const hashSection = useOpenOnHash()
  /**
   * ONE band open at a time.
   *
   * Every band staying open grew the plate without limit, so opening the fifth thing left
   * it pinned to the bottom of a very long page under four expanded ones you were no longer
   * reading. An accordion keeps the plate a legible size and keeps the rail's marker
   * meaningful, since "the section you are in" stops being a useful idea when five of them
   * are in view.
   */
  const [openSectionId, setOpenSectionId] = useState<string | null>('appearance')

  /**
   * The section the reader last CHOSE, which pins the rail until they scroll away.
   *
   * Owned here rather than read back out of the URL, because the rail writes the hash with
   * `replaceState` — which fires no `hashchange`, so a hash-derived pin never engaged and
   * the marker snapped straight back to whatever the scroll tracker said. Clicking Security
   * left the rail pointing at Calendars.
   */
  const [pinnedSection, setPinnedSection] = useState<string | null>(null)
  const openSection = useVisibleSection(SECTION_IDS, pinnedSection)

  // A hash, on arrival or from the back button, opens what it names and pins it.
  useEffect(() => {
    if (hashSection === null) return
    setOpenSectionId(hashSection)
    setPinnedSection(hashSection)
  }, [hashSection])

  /**
   * Open or close a band. NO scrolling here, deliberately.
   *
   * This used to scroll the newly opened band into view, which was the second half of the
   * jump-to-the-bottom bug: clicking a rail item fired the browser's anchor jump AND this,
   * both against a layout that was still collapsing the previous band. Clicking a summary
   * needs no scroll at all — the reader's pointer is already on the thing that just opened,
   * and the content expands underneath it, which is exactly where they are looking.
   */
  const openBand = (id: string, next: boolean) => {
    setOpenSectionId(next ? id : (previous) => (previous === id ? null : previous))
  }

  /**
   * A rail click: open the band, then bring it into view ONCE THE PAGE HAS SETTLED.
   *
   * Two frames, not one. The first lets React commit the new open state; the second lets
   * the browser lay out the shorter document that results from closing the previous band.
   * Scrolling before either has happened is scrolling to a position that is about to mean
   * something else, which is how this landed at the bottom of the page.
   *
   * `block: 'nearest'` because with one band open at a time the target is usually already
   * on screen, and moving a section that was fine where it was is worse than not moving.
   */
  const selectBand = (id: string) => {
    setOpenSectionId(id)
    setPinnedSection(id)

    /**
     * WAIT FOR THE PAGE TO STOP MOVING, then put the clicked band's head at the top.
     *
     * Four rounds landed at the foot of the page. The last one is the lesson:
     *
     *   1. `scrollIntoView` on the `<details>` fits the ELEMENT, and an open band is taller
     *      than the viewport, so it pushed down until the bottom edge showed.
     *   2. Two animation frames is not long enough; the closing band is still mid-collapse.
     *   3. Closing a tall band SHRINKS the document and the browser clamps the scroll to the
     *      new maximum, before any of our code runs. "Only scroll if not already visible"
     *      cannot help, because after the clamp the summary IS on screen, tucked under the
     *      sticky bar with the footer filling the view.
     *   4. And a fixed timeout is a GUESS. `settle + 40` was right on my machine and wrong
     *      on Keith's, whose symptom named the cause exactly: he had to click twice, because
     *      the second click ran against a layout that had finally stopped changing. Timing a
     *      transition by hoping is not timing it.
     *
     * So this watches the document height until it holds still for three frames, with a
     * hard ceiling so a page that never settles cannot hang the interaction. Then it scrolls
     * unconditionally: the band you clicked puts its head at the top, which is what an anchor
     * has always done and what nobody has to think about.
     */
    const scrollWhenSettled = () => {
      const summary = document.getElementById(id)?.querySelector('summary')
      if (summary === null || summary === undefined) return

      let lastTop = Number.NaN
      let steady = 0
      let frames = 0
      const tick = () => {
        /**
         * The TARGET's absolute offset, not the document height.
         *
         * Watching `scrollHeight` looked equivalent and was not: `--ease-decelerate` ends
         * slowly, so the last stretch of the collapse moves by sub-pixel amounts that round
         * to the same integer for several frames. The check called that "settled", scrolled
         * to where the summary was at that moment, and then the remaining travel slid it
         * further up — overshooting by about thirty pixels, off the top of the screen.
         *
         * Adding scrollY makes this a document coordinate, so it does not move merely
         * because we are about to scroll.
         */
        const top = Math.round(summary.getBoundingClientRect().top + window.scrollY)
        if (top === lastTop) steady += 1
        else {
          steady = 0
          lastTop = top
        }
        frames += 1
        // Five steady frames, or roughly a second, whichever comes first.
        if (steady < 5 && frames < 60) {
          requestAnimationFrame(tick)
          return
        }
        summary.scrollIntoView({ block: 'start', behavior: 'smooth' })
      }
      requestAnimationFrame(tick)
    }
    scrollWhenSettled()
  }
  /**
   * Where the reader IS, not where they were sent. A hash stops being the answer the moment
   * someone scrolls, and a rail that keeps pointing at the last thing they clicked is a rail
   * that is quietly wrong most of the time.
   */

  // The provider's page: calendars carry their sealed names; occurrences are empty because
  // settings renders none. Withheld/audience fields are the owner's trivially.
  const page = useMemo<RedactedPage>(
    () => ({
      timezone: prefs?.timezone ?? 'UTC',
      from: '',
      to: '',
      audience: 'owner',
      calendars: calendars.map(({ id, colorToken, fields }) => ({ id, colorToken, fields })),
      occurrences: [],
      withheldCount: 0,
    }),
    [prefs?.timezone, calendars],
  )

  // Contact and group names ride in through the extraFields door (see CloakProvider).
  const nameFields = useMemo<readonly ExtraSealedField[]>(
    () =>
      audiences.flatMap((option) =>
        option.nameField === undefined
          ? []
          : [
              {
                subjectType:
                  option.kind === 'group' ? ('contact_group' as const) : ('contact' as const),
                subjectId: option.id,
                field: option.nameField,
              },
            ],
      ),
    [audiences],
  )


  const contacts = audiences.filter((a) => a.kind === 'individual').length
  const groups = audiences.filter((a) => a.kind === 'group').length

  return (
    <CloakProvider page={page} email={email} extraFields={nameFields}>
      <PageShell back={{ href: '/', label: 'Calendar' }}>
        <PageMasthead
          title="Settings"
          lede="How your calendar looks and behaves, who can see what, and how you get back in."
        />

        {/* THE READING PLATE. Your own figures, at display size, in the register's hand.
            The top of this page was a serif word, a grey sentence and then boxes; this
            makes the first thing you see your own data. Every figure is one the page
            already computed for its section rows, so nothing new is derived here. */}
        <dl className={styles.readout} aria-label="At a glance">
          <div className={styles.reading}>
            <dt className={styles.readingLabel}>Calendars</dt>
            <dd className={styles.readingValue}>{String(calendars.length).padStart(2, '0')}</dd>
          </div>
          <div className={styles.reading}>
            <dt className={styles.readingLabel}>People</dt>
            <dd className={styles.readingValue}>{String(contacts).padStart(2, '0')}</dd>
          </div>
          <div className={styles.reading}>
            <dt className={styles.readingLabel}>Rules</dt>
            <dd className={styles.readingValue}>{String(workspaceRules.length).padStart(2, '0')}</dd>
          </div>
          <div className={styles.reading}>
            <dt className={styles.readingLabel}>Opens on</dt>
            <dd className={styles.readingValue}>{VIEW_LABELS[prefs?.defaultView ?? 'agenda']}</dd>
          </div>
        </dl>

        <div className={`${styles.layout} ${styles.scrollRoom}`}>
          {/* Said ONCE, at the top, rather than inside each card that happens to be
              writable. It was in two cards a moment ago and read as an app apologising
              twice for the same thing. */}
          {fixtureMode && (
            <p className={styles.demoBanner}>
              Demo. Display choices are kept in this browser only, so you can try them
              without an account. Anything that would change real data stays closed.
            </p>
          )}

          <SettingsNav current={openSection} onSelect={selectBand} />

          <main id="main" className={styles.sections}>
            <SettingsSection
              id="appearance"
              open={openSectionId === 'appearance'}
              onOpen={(next) => openBand('appearance', next)}
              title="Appearance"
              description={describe('appearance')}
              state={`${VIEW_LABELS[prefs?.defaultView ?? 'agenda']} · shortcuts ${
                prefs?.keyboardShortcuts === true ? 'on' : 'off'
              }`}
            >
              <AppearanceSection
                workspaceId={workspaceId}
                fixtureMode={fixtureMode}
                defaultView={prefs?.defaultView ?? 'agenda'}
                keyboardShortcuts={prefs?.keyboardShortcuts ?? false}
              />
            </SettingsSection>

            <SettingsSection
              id="time-region"
              open={openSectionId === 'time-region'}
              onOpen={(next) => openBand('time-region', next)}
              title="Time & region"
              description={describe('time-region')}
              state={
                prefs === null
                  ? 'Not set up yet'
                  : `${prefs.timezone.replaceAll('_', ' ')} · weeks start ${WEEKDAY_NAMES[prefs.weekStart]}`
              }
            >
              <TimeRegionSection
                workspaceId={workspaceId}
                fixtureMode={fixtureMode}
                timezone={prefs?.timezone ?? null}
                weekStart={prefs?.weekStart ?? 0}
                holidayRegion={prefs?.holidayRegion ?? 'auto'}
              />
            </SettingsSection>

            <SettingsSection
              id="calendars"
              open={openSectionId === 'calendars'}
              onOpen={(next) => openBand('calendars', next)}
              title="Calendars"
              description={describe('calendars')}
              state={`${calendars.length} ${calendars.length === 1 ? 'calendar' : 'calendars'}`}
            >
              <CalendarsSection fixtureMode={fixtureMode} calendars={calendars} />
            </SettingsSection>

            {/* People and Visibility were two cards, and one of them held no settings at
                all — a lede and a link across to /people. Splitting "who exists" from
                "what they see" put a signpost and the thing it points near in separate
                boxes for no reason a reader could name. One card: the book is the door,
                the link and group defaults are decided here, and per-person rules still
                live in the person's file where the preview of them is. */}
            <SettingsSection
              id="sharing"
              open={openSectionId === 'sharing'}
              onOpen={(next) => openBand('sharing', next)}
              title="People & sharing"
              description={describe('sharing')}
              state={
                contacts === 0 && groups === 0
                  ? 'Nobody yet'
                  : [
                      `${contacts} ${contacts === 1 ? 'contact' : 'contacts'}`,
                      ...(groups > 0 ? [`${groups} ${groups === 1 ? 'group' : 'groups'}`] : []),
                      workspaceRules.length === 0
                        ? 'no rules'
                        : `${workspaceRules.length} ${workspaceRules.length === 1 ? 'rule' : 'rules'}`,
                    ].join(' · ')
              }
            >
              <p className={styles.sectionLede}>
                Your contacts live in People: add and rename them, organize groups, and
                decide what each person sees, beside a preview of what they get.
              </p>
              <div>
                <ButtonLink variant="outline" href={{ pathname: '/people' }}>
                  Open People
                </ButtonLink>
              </div>

              <div className={styles.subSection}>
                <div className={styles.panelHead}>
                  <h3 className={styles.panelTitle}>Defaults</h3>
                </div>
                <VisibilitySection
                  workspaceId={workspaceId}
                  fixtureMode={fixtureMode}
                  audiences={audiences}
                  rules={workspaceRules}
                  groupsByContact={groupsByContact}
                />
              </div>
            </SettingsSection>

            {/* A signpost, like People. The password and recovery-phrase flows are a page
                of their own now: they arrived here carrying their own lockup and their own
                h1, so /settings rendered two h1s and a stray brand mark mid-scroll. */}
            {/* A signpost, like Security and Plan. Seven days of multi-window rows is a
                page, not a row inside an accordion that opens one band at a time. */}
            <SettingsSection
              id="availability"
              open={openSectionId === 'availability'}
              onOpen={(next) => openBand('availability', next)}
              title="Availability"
              description={describe('availability')}
              state={availability}
            >
              <p className={styles.sectionLede}>
                The hours you are open, per weekday. Your calendar shades the hours outside
                them, so a week at a glance shows when you are actually working.
              </p>
              {/* The honest boundary, stated here as well as on the page: someone deciding
                  whether to open this card deserves to know it does not book anything. */}
              <p className={styles.sectionLede}>
                Nothing books itself yet. Booking pages are not built.
              </p>
              <div>
                <ButtonLink variant="outline" href={{ pathname: '/settings/availability' }}>
                  Open Availability
                </ButtonLink>
              </div>
            </SettingsSection>

            <SettingsSection
              id="security"
              open={openSectionId === 'security'}
              onOpen={(next) => openBand('security', next)}
              title="Security"
              description={describe('security')}
              state="Password & recovery phrase"
            >
              <p className={styles.sectionLede}>
                Your password, your passkeys and your recovery phrase all open the same
                key. Changing any one of them re-wraps that key; none of them touches an
                event.
              </p>
              {/* fixtureMode, not `email === ''`. The two are the same thing here today
                  and are not the same FACT — a signed-in account with no email would have
                  been told it was a demo. */}
              {fixtureMode ? (
                <p className={styles.lockedNote}>
                  Demo. Sign in to manage your password and recovery phrase.
                </p>
              ) : (
                <>
                  <div>
                    <ButtonLink variant="outline" href={{ pathname: '/settings/security' }}>
                      Open Security
                    </ButtonLink>
                  </div>
                  <div>
                    <SignOutButton />
                  </div>
                </>
              )}
            </SettingsSection>

            {/* A signpost, like Security. Prices, a comparison and a roadmap do not fit in
                a band that opens one at a time, and a card holding only a lede and a link
                is the shape the seven-to-five pass deleted. This one says what it is and
                points at the page. */}
            <SettingsSection
              id="plan"
              open={openSectionId === 'plan'}
              onOpen={(next) => openBand('plan', next)}
              title="Plan"
              description={describe('plan')}
              /* "Demo", not "Free". A plan is an ACCOUNT fact and the fixture has no
                 account, so printing Free here would be one string answering two different
                 questions — the same error as inferring the demo from an empty email. */
              state={fixtureMode ? 'Demo' : planById(plan).name}
            >
              <p className={styles.sectionLede}>
                Free covers everything CloakCal does today. Pro is named and priced on the
                plan page, and cannot be bought yet: billing opens when sign-ups do.
              </p>
              {/* Unlike Security, this link is offered in the demo too. The plan page reads
                  no account state and renders the same either way, so pointing at it is not
                  the dead end the security link would be. */}
              <div>
                <ButtonLink variant="outline" href={{ pathname: '/settings/plan' }}>
                  Open Plan
                </ButtonLink>
              </div>
            </SettingsSection>
          </main>

          {/* Not a card. Four things that do not exist yet had the same shape, weight and
              chevron as four that do, which is most of what made this page read as half
              built: a third of it was furniture. They are named, because an honest roadmap
              is worth something, and they are quiet, because nothing here works. */}
          <footer className={styles.whatsNext}>
            <div className={styles.panelHead}>
              <h2 className={styles.panelTitle}>What&apos;s next</h2>
              <span className={styles.panelCount}>04</span>
            </div>
            <p className={styles.deferredRow}>
              <span className={styles.deferredName}>Device pairing</span>
              <span className={styles.soon}>Coming soon</span>
              Approve a new sign-in from a device you already trust.
            </p>
            <p className={styles.deferredRow}>
              <span className={styles.deferredName}>Booking</span>
              <span className={styles.soon}>Coming soon</span>
              Let people book time with you. Hard here on purpose: your contacts are
              encrypted, so matching a stranger&apos;s email to one is a real design
              problem, not a form.
            </p>
            <p className={styles.deferredRow}>
              <span className={styles.deferredName}>Export</span>
              <span className={styles.soon}>Coming soon</span>
              Take your calendar out, decrypted by you, on your machine.
            </p>
            <p className={styles.deferredRow}>
              <span className={styles.deferredName}>Deleting calendars</span>
              <span className={styles.soon}>Coming soon</span>
              Deleting a calendar needs an answer for the events it holds. Creating one
              works now, from the sidebar or the Calendars card above.
            </p>

            {/* Reachable from inside the account as well as from the landing footer. Someone
                deciding whether to trust the product reads these before signing up; someone
                deciding whether to keep trusting it reads them after, and should not have to
                sign out to find them. */}
            <p className={styles.legalRow}>
              <Link href="/privacy">Privacy</Link>
              <Link href="/terms">Terms</Link>
            </p>
          </footer>
        </div>
      </PageShell>
    </CloakProvider>
  )
}
