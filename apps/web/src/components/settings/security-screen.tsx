'use client'

import type { SettingsDevice } from '@/server/settings'
import { PageMasthead, PageShell } from '../page-shell'
import { SettingsNav } from './settings-nav'
import { ChangePassword } from '../change-password'
import { PasskeysSection } from '../passkeys-section'
import { ReissueRecoveryPhrase } from '../reissue-recovery-phrase'
import { SignOutButton } from '../sign-out-button'
import styles from './settings.module.css'

/**
 * /settings/security — password, recovery phrase, devices, sign out.
 *
 * The page chrome lives HERE now, not inside ChangePassword, which used to carry a lockup
 * and an <h1> of its own into whatever rendered it. One h1 per page, and the components
 * below are sections of it.
 *
 * Devices moved here from the bottom of the "Coming soon" card, where they rendered with
 * no heading at all, under a list of things that do not exist yet. A device that can open
 * your calendar is a security fact, and it was filed under the roadmap.
 */
export function SecurityScreen({
  demo,
  email,
  devices,
}: {
  /**
   * The dev fixture, said OUT LOUD rather than inferred from an empty email.
   *
   * This branched on `email === ''` until it was pointed out that the sentinel had quietly
   * become load-bearing for a whole route: a signed-in user whose Supabase `email` is null
   * — phone auth, or an OAuth identity that returns none — would have been shown "Demo.
   * Sign in to manage your password" while signed in, with no way to tell that the page had
   * simply misread them. Two different facts were sharing one test.
   */
  demo: boolean
  email: string
  devices: readonly SettingsDevice[]
}) {
  return (
    /* WIDE, and with the rail, like /settings itself. This page used to be a 46rem column
       with no navigation, so opening Security read as leaving Settings rather than moving
       inside it: the measure jumped 18rem and the only way back was the chevron. Keeping
       the rail and swapping the panel beside it is what makes a submenu part of its menu.
       The measure is also forced — a 13rem rail inside 46rem leaves less content width
       than a single form wants. */
    <PageShell back={{ href: '/settings', label: 'Settings' }}>
      <PageMasthead
        title="Security"
        lede="Your password, your passkeys and your recovery phrase all open the same key. Changing any one of them re-wraps that key; none of them touches an event."
      />

      <div className={styles.layout}>
        <SettingsNav current="security" scope="settings" />

        <main id="main" className={styles.sections}>
          {demo ? (
            /* The demo renders the Passkeys card too, disabled, and that is a TESTING
               decision as much as an honesty one. Every Playwright project runs in fixture
               mode, so a control that appears only for signed-in users is measured by
               nothing — not the axe scan on this page, not the 44px target sweep. Rendering
               it here, honestly disabled, is what puts it in front of both. */
            <>
              <p className={styles.lockedNote}>
                Demo. Sign in to manage your password and recovery phrase.
              </p>
              <PasskeysSection email={email} demo />
            </>
          ) : email === '' ? (
            /* Signed in, but the account carries no email address. Not a demo and not a
               bug in this page: the email IS the KDF salt (see /account in CLAUDE.md), so
               there is genuinely nothing to derive a wrap key from, and both flows below
               would fail in a way that looks like a wrong password. Saying so is the only
               honest option until an account can be created without one. */
            <p className={styles.lockedNote}>
              This account has no email address on it. Your password and recovery phrase are
              both derived from it, so neither can be changed here. Get in touch and we will
              sort it out.
            </p>
          ) : (
            <>
              {/* Password first: it is the errand people come for. The phrase re-issue is
                  the one they need and do not know exists, so it stays visible below rather
                  than behind a menu. */}
              <ChangePassword email={email} />
              <ReissueRecoveryPhrase email={email} />
              {/* After the two things people arrive for, before the Devices inventory: a
                  passkey is a WAY IN, and devices are a list of what got in. */}
              <PasskeysSection email={email} demo={false} />

              <section className={styles.band}>
                <div className={styles.panelHead}>
                  <h2 className={styles.panelTitle}>Devices</h2>
                  <span className={styles.panelCount}>
                    {String(devices.length).padStart(2, '0')}
                  </span>
                </div>
                {devices.length === 0 ? (
                  <p className={styles.rowNote}>
                    Only this browser so far. Add a passkey above and your face, fingerprint
                    or device PIN opens your calendar, with the recovery phrase kept as the
                    last resort rather than the only one.
                  </p>
                ) : (
                  <ul className={styles.plainList}>
                    {devices.map((device) => (
                      <li key={device.id} className={styles.row}>
                        <span className={styles.rowLabel}>{device.label}</span>
                        <span className={styles.rowMeta}>
                          {device.revokedAt !== null
                            ? 'Revoked'
                            : device.lastSeenAt !== null
                              ? `Last seen ${device.lastSeenAt.slice(0, 10)}`
                              : 'Never seen'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <div>
                <SignOutButton />
              </div>
            </>
          )}
        </main>
      </div>
    </PageShell>
  )
}
