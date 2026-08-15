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
  email,
  devices,
}: {
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
          {email === '' ? (
            <p className={styles.lockedNote}>
              Demo. Sign in to manage your password and recovery phrase.
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
