'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { VisibilityRule } from '@cloakcal/policy'
import type { RedactedPage } from '@/server/audience'
import type { CalendarPrefs, SettingsCalendar } from '@/server/settings'
import type { AudienceOption } from '@/lib/audiences'
import { VIEW_LABELS } from '@/lib/calendar-views'
import { SECTIONS } from '@/lib/settings-sections'
import { SettingsNav } from './settings-nav'
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
  defaultOpen = false,
  children,
}: {
  id: string
  title: string
  /** What the card is FOR — the middle level of the closed row's three. */
  description: string
  /** Plain-language current value shown while closed. */
  state: string
  defaultOpen?: boolean
  children: ReactNode
}) {
  return (
    <details id={id} className={styles.section} open={defaultOpen}>
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
}: SettingsProps) {
  const openSection = useOpenOnHash()

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

        <div className={styles.layout}>
          {/* Said ONCE, at the top, rather than inside each card that happens to be
              writable. It was in two cards a moment ago and read as an app apologising
              twice for the same thing. */}
          {fixtureMode && (
            <p className={styles.demoBanner}>
              Demo. Display choices are kept in this browser only, so you can try them
              without an account. Anything that would change real data stays closed.
            </p>
          )}

          <SettingsNav current={openSection} />

          <main id="main" className={styles.sections}>
            <SettingsSection
              id="appearance"
              title="Appearance"
              description={describe('appearance')}
              state={`${VIEW_LABELS[prefs?.defaultView ?? 'agenda']} · shortcuts ${
                prefs?.keyboardShortcuts === true ? 'on' : 'off'
              }`}
              defaultOpen
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
              />
            </SettingsSection>

            <SettingsSection
              id="calendars"
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
            <SettingsSection
              id="security"
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
          </footer>
        </div>
      </PageShell>
    </CloakProvider>
  )
}
