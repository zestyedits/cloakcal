'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import type { VisibilityRule } from '@cloakcal/policy'
import type { RedactedPage } from '@/server/audience'
import type { SettingsCalendar, SettingsDevice, WorkspacePrefs } from '@/server/settings'
import type { AudienceOption } from '@/lib/audiences'
import { CloakProvider, type ExtraSealedField } from '../cloak-provider'
import { CloakLockup } from '../cloak-logo'
import { ThemeToggle } from '../theme-toggle'
import { ChangePassword } from '../change-password'
import { ReissueRecoveryPhrase } from '../reissue-recovery-phrase'
import { AppearanceSection } from './appearance-section'
import { TimeRegionSection } from './time-region-section'
import { CalendarsSection } from './calendars-section'
import { PeopleSection } from './people-section'
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

const SECTIONS = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'time-region', label: 'Time & region' },
  { id: 'calendars', label: 'Calendars' },
  { id: 'people', label: 'People' },
  { id: 'visibility', label: 'Visibility' },
  { id: 'security', label: 'Security' },
  { id: 'more', label: 'Coming soon' },
] as const

/** Serializable throughout: this crosses the RSC boundary. Maps arrive as plain records. */
export interface SettingsProps {
  readonly email: string
  readonly fixtureMode: boolean
  readonly prefs: WorkspacePrefs | null
  readonly calendars: readonly SettingsCalendar[]
  readonly devices: readonly SettingsDevice[]
  readonly audiences: readonly AudienceOption[]
  readonly workspaceRules: readonly VisibilityRule[]
  readonly membersByGroup: Readonly<Record<string, readonly string[]>>
  readonly groupsByContact: Readonly<Record<string, readonly string[]>>
}

export function SettingsScreen({
  email,
  fixtureMode,
  prefs,
  calendars,
  devices,
  audiences,
  workspaceRules,
  membersByGroup,
  groupsByContact,
}: SettingsProps) {
  const workspaceId = prefs?.workspaceId ?? null

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

  return (
    <CloakProvider page={page} email={email} extraFields={nameFields}>
      <div className={styles.page}>
        <header className={styles.header}>
          <Link className={styles.back} href="/">
            ‹ Calendar
          </Link>
          <div className={styles.headerSpace} />
          <CloakLockup size="sm" />
          <div className={styles.headerSpace} />
          <ThemeToggle />
        </header>

        <div className={styles.body}>
          <h1 className={styles.title}>Settings</h1>

          <nav className={styles.nav} aria-label="Settings sections">
            {SECTIONS.map((section) => (
              <a key={section.id} className={styles.navLink} href={`#${section.id}`}>
                {section.label}
              </a>
            ))}
          </nav>

          <main id="main" className={styles.sections}>
            <AppearanceSection />

            <TimeRegionSection
              workspaceId={workspaceId}
              fixtureMode={fixtureMode}
              timezone={prefs?.timezone ?? null}
              weekStart={prefs?.weekStart ?? 0}
            />

            <CalendarsSection fixtureMode={fixtureMode} calendars={calendars} />

            <PeopleSection
              workspaceId={workspaceId}
              fixtureMode={fixtureMode}
              audiences={audiences}
              membersByGroup={membersByGroup}
            />

            <VisibilitySection
              workspaceId={workspaceId}
              fixtureMode={fixtureMode}
              audiences={audiences}
              rules={workspaceRules}
              groupsByContact={groupsByContact}
            />

            <section id="security" className={styles.section} aria-labelledby="security-title">
              <h2 id="security-title" className={styles.sectionTitle}>
                Security
              </h2>
              <p className={styles.sectionLede}>
                Your password and recovery phrase both open the same root key. Changing either
                re-wraps that key — nothing is re-encrypted.
              </p>
              {email === '' ? (
                <p className={styles.lockedNote}>
                  Demo data — sign in to manage your password and recovery phrase.
                </p>
              ) : (
                <>
                  {/* Password first: it is the errand people come for. The phrase re-issue is
                      the one they need and do not know exists, so it stays visible below
                      rather than behind a menu — same reasoning as /account, whose contents
                      moved here. */}
                  <ChangePassword email={email} />
                  <ReissueRecoveryPhrase email={email} />
                </>
              )}
            </section>

            <section id="more" className={styles.section} aria-labelledby="more-title">
              <h2 id="more-title" className={styles.sectionTitle}>
                Coming soon
              </h2>
              <p className={styles.sectionLede}>
                Named here so the roadmap is honest, and quiet so it never outranks what works.
              </p>

              {devices.length > 0 && (
                <div>
                  {devices.map((device) => (
                    <p key={device.id} className={styles.deferredRow}>
                      <span className={styles.deferredName}>{device.label}</span>
                      {device.revokedAt !== null
                        ? 'Revoked'
                        : device.lastSeenAt !== null
                          ? `Last seen ${device.lastSeenAt.slice(0, 10)}`
                          : 'Never seen'}
                    </p>
                  ))}
                </div>
              )}

              <div>
                <p className={styles.deferredRow}>
                  <span className={styles.deferredName}>Device pairing</span>
                  <span className={styles.soon}>Coming soon</span>
                  Approve sign-ins from another device, so the recovery phrase becomes a last
                  resort instead of the only route back in.
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
                  <span className={styles.deferredName}>New calendars</span>
                  <span className={styles.soon}>Coming soon</span>
                  Creating and deleting calendars needs an answer for the events they hold.
                </p>
              </div>
            </section>
          </main>
        </div>
      </div>
    </CloakProvider>
  )
}
