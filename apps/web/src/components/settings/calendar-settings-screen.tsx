'use client'

import { useMemo } from 'react'
import type { RedactedPage } from '@/server/audience'
import type { CalendarPrefs, SettingsCalendar } from '@/server/settings'
import { CloakProvider } from '../cloak-provider'
import { PageMasthead, PageShell } from '../page-shell'
import { ButtonLink } from '../ui/button'
import { AppearanceSection } from './appearance-section'
import { CalendarsSection } from './calendars-section'
import { SettingsSiblings } from './settings-doors'
import { TimeRegionSection } from './time-region-section'
import styles from './settings.module.css'

/**
 * /settings/calendar — the calendars themselves, the time they are drawn in, how they look,
 * and a way through to the hours you are open.
 *
 * Three of the old seven accordion cards, on one page, in the order they matter: the list of
 * calendars is what the door is named for; time and region frames every render; appearance is
 * display. Availability is a signpost rather than a section, for the reason it was extracted
 * in the first place — seven days of multi-window rows is a page.
 *
 * WHY AVAILABILITY IS FILED UNDER CALENDAR AND NOT PRIVACY: today it does exactly one thing,
 * which is shade the hours outside your windows on the week and day grids. That is a display
 * behaviour. When booking ships it becomes a thing other people act on, and it should move
 * across then rather than be filed under a promise now.
 *
 * Calendar display names are CIPHERTEXT, so this is a client component inside CloakProvider.
 */
export function CalendarSettingsScreen({
  email,
  fixtureMode,
  prefs,
  workspaceId,
  calendars,
  availability,
  billingEnabled,
}: {
  readonly email: string
  readonly fixtureMode: boolean
  readonly prefs: CalendarPrefs | null
  readonly workspaceId: string | null
  readonly calendars: readonly SettingsCalendar[]
  /** Already formatted by the server: this page shows one line, not the week. */
  readonly availability: string
  readonly billingEnabled: boolean
}) {
  // Calendars carry their sealed names; occurrences are empty because this renders none.
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

  return (
    <CloakProvider page={page} email={email}>
      <PageShell back={{ href: '/settings', label: 'Settings' }} measure="narrow">
        <PageMasthead
          title="Calendar"
          lede="Your calendars, the time they are drawn in, how they look, and the hours you are open."
        />

        <main id="main" className={styles.sections}>
          {fixtureMode && (
            /* Said ONCE, at the top, rather than inside each control that happens to be
               writable. It was in two cards a moment ago and read as an app apologising
               twice for the same thing. */
            <p className={styles.demoBanner}>
              Demo. Display choices are kept in this browser only, so you can try them without
              an account. Anything that would change real data stays closed.
            </p>
          )}

          <section className={styles.band}>
            <div className={styles.panelHead}>
              <h2 className={styles.panelTitle}>Calendars</h2>
              <span className={styles.panelCount}>
                {String(calendars.length).padStart(2, '0')}
              </span>
            </div>
            <CalendarsSection fixtureMode={fixtureMode} calendars={calendars} />
            {/* The gap, stated where it bites rather than in a roadmap footer three screens
                away. Creating one works; deleting one needs an answer for the events it
                holds, and `events.calendar_id` is `on delete restrict` until it has one. */}
            <p className={styles.rowNote}>
              Calendars cannot be deleted yet. Deleting one needs an answer for the events it
              holds, and we would rather not guess at that on your behalf.
            </p>
          </section>

          <section className={styles.band}>
            <div className={styles.panelHead}>
              <h2 className={styles.panelTitle}>Time &amp; region</h2>
            </div>
            <TimeRegionSection
              workspaceId={workspaceId}
              fixtureMode={fixtureMode}
              timezone={prefs?.timezone ?? null}
              weekStart={prefs?.weekStart ?? 0}
              holidayRegion={prefs?.holidayRegion ?? 'auto'}
            />
          </section>

          <section className={styles.band}>
            <div className={styles.panelHead}>
              <h2 className={styles.panelTitle}>Appearance</h2>
            </div>
            <AppearanceSection
              workspaceId={workspaceId}
              fixtureMode={fixtureMode}
              defaultView={prefs?.defaultView ?? 'agenda'}
              keyboardShortcuts={prefs?.keyboardShortcuts ?? false}
            />
          </section>

          <section className={styles.band}>
            <div className={styles.panelHead}>
              <h2 className={styles.panelTitle}>Availability</h2>
              <span className={styles.panelCount}>{availability}</span>
            </div>
            <p className={styles.sectionLede}>
              The hours you are open, per weekday. Your calendar shades the hours outside them,
              so a week at a glance shows when you are actually working.
            </p>
            {/* The honest boundary, stated here as well as on the page itself: someone
                deciding whether to open this deserves to know it does not book anything. */}
            <p className={styles.sectionLede}>Nothing books itself yet. Booking pages are not built.</p>
            <div>
              <ButtonLink variant="outline" href={{ pathname: '/settings/availability' }}>
                Open Availability
              </ButtonLink>
            </div>
          </section>
        </main>

        <SettingsSiblings current="calendar" billingEnabled={billingEnabled} />
      </PageShell>
    </CloakProvider>
  )
}
