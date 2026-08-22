'use client'

import { useMemo } from 'react'
import type { VisibilityRule } from '@cloakcal/policy'
import type { RedactedPage } from '@/server/audience'
import type { AudienceOption } from '@/lib/audiences'
import { CloakProvider, type ExtraSealedField } from '../cloak-provider'
import { PageMasthead, PageBody } from '../page-shell'
import { ButtonLink } from '../ui/button'
import { SettingsSiblings } from './settings-doors'
import { VisibilitySection } from './visibility-section'
import styles from './settings.module.css'

/**
 * /settings/privacy — the first door, because it is the product.
 *
 * It used to be the FOURTH of seven accordion cards, called "People & sharing", which was
 * wrong twice over: it buried the one setting CloakCal exists for under a generic label, and
 * it promised sharing that is not built — nothing can be sent to anyone yet, `access_envelopes`
 * is still unused. What this page actually decides is what each audience sees, so that is
 * what it is called and that is the first thing on it.
 *
 * Contact and group names are CIPHERTEXT (ADR 0004: `contacts` carries no name column), so
 * this is a client component inside CloakProvider. Before unlock the rows read "Contact
 * 4f2a…", which is exactly what the server sees.
 */
export function PrivacyScreen({
  email,
  fixtureMode,
  timezone,
  workspaceId,
  audiences,
  workspaceRules,
  groupsByContact,
  billingEnabled,
}: {
  readonly email: string
  readonly fixtureMode: boolean
  readonly timezone: string
  readonly workspaceId: string | null
  readonly audiences: readonly AudienceOption[]
  readonly workspaceRules: readonly VisibilityRule[]
  /** Maps do not cross the RSC boundary; this arrives flattened. */
  readonly groupsByContact: Readonly<Record<string, readonly string[]>>
  readonly billingEnabled: boolean
}) {
  /*
   * The provider's page: no calendars and no occurrences, because this screen renders
   * neither. Contact and group names ride in through `extraFields`, which is the door
   * `CloakProvider` grew when real accounts turned out to show "Contact 4f2a…" forever.
   */
  const page = useMemo<RedactedPage>(
    () => ({
      timezone,
      from: '',
      to: '',
      audience: 'owner',
      calendars: [],
      occurrences: [],
      withheldCount: 0,
    }),
    [timezone],
  )

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
      {/* NARROW, like every settings sub-page. Without a rail beside it, 64rem of form is a
          line-length problem rather than a use of the space. */}
      <PageBody measure="narrow">
        <PageMasthead
          title="Privacy"
          lede="What each person and group sees of your calendar, and who those people are."
        />

        <main id="main" className={styles.sections}>
          {fixtureMode && (
            <p className={styles.demoBanner}>
              Demo. Nothing here can be saved, because there is no account behind it. The
              rules below are the example ones the demo calendar is drawn from.
            </p>
          )}

          {/* THE CONTROL FIRST, signposts after. This is the setting the page is named for
              and it should not be the third thing on it. */}
          <section className={styles.band}>
            <div className={styles.panelHead}>
              <h2 className={styles.panelTitle}>Who sees what by default</h2>
            </div>
            <VisibilitySection
              workspaceId={workspaceId}
              fixtureMode={fixtureMode}
              audiences={audiences}
              rules={workspaceRules}
              groupsByContact={groupsByContact}
            />
          </section>

          <section className={styles.band}>
            <div className={styles.panelHead}>
              <h2 className={styles.panelTitle}>People</h2>
            </div>
            <p className={styles.sectionLede}>
              Your contacts live in People: add and rename them, organize groups, and decide
              what each person sees, beside a preview of what they get.
            </p>
            <div>
              <ButtonLink variant="outline" href={{ pathname: '/people' }}>
                Open People
              </ButtonLink>
            </div>
          </section>

          {/*
            A LINK TO THE CALENDAR, NOT A THIRD AUDIENCE PICKER.
            The sidebar's View As bar and the Cloak sheet already both draw the audience map,
            and the last time two surfaces did that on one screen there were two live selects
            bound to the same state. This says where the preview lives and gets out of the way.
          */}
          <section className={styles.band}>
            <div className={styles.panelHead}>
              <h2 className={styles.panelTitle}>See what they see</h2>
            </div>
            <p className={styles.sectionLede}>
              View As redraws your own calendar as one person or group receives it, hidden
              events and all. It lives on the calendar itself, in the sidebar and behind the
              Cloak button, because what you want to check is a week rather than a setting.
            </p>
            <div>
              <ButtonLink variant="outline" href={{ pathname: '/' }}>
                Open the calendar
              </ButtonLink>
            </div>
          </section>
        </main>

        <SettingsSiblings current="privacy" billingEnabled={billingEnabled} />
      </PageBody>
    </CloakProvider>
  )
}
