'use client'

import Link from 'next/link'
import type { SettingsDevice } from '@/server/settings'
import { CloakHomeLink } from '../cloak-logo'
import { ThemeToggle } from '../theme-toggle'
import { ChangePassword } from '../change-password'
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
    <div className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.back} href="/settings">
          ‹ Settings
        </Link>
        <div className={styles.headerSpace} />
        <CloakHomeLink size="sm" />
        <div className={styles.headerSpace} />
        <ThemeToggle />
      </header>

      <div className={styles.narrowBody}>
        <h1 className={styles.title}>Security</h1>
        <p className={styles.pageLede}>
          Your password and your recovery phrase both open the same key. Changing either one
          re-wraps that key; neither one touches an event.
        </p>

        <main id="main" className={styles.sections}>
          {demo ? (
            <p className={styles.lockedNote}>
              Demo. Sign in to manage your password and recovery phrase.
            </p>
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

              <section className={styles.panel}>
                <div className={styles.panelHead}>
                  <h2 className={styles.panelTitle}>Devices</h2>
                  <span className={styles.panelCount}>
                    {String(devices.length).padStart(2, '0')}
                  </span>
                </div>
                {devices.length === 0 ? (
                  <p className={styles.rowNote}>
                    Only this browser so far. Pairing another device is the next milestone;
                    until then your recovery phrase is the single way back in.
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
    </div>
  )
}
