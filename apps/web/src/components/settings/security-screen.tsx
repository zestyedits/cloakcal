'use client'

import Link from 'next/link'
import type { SettingsDevice } from '@/server/settings'
/*
 * `@/lib/contact`, not `@/lib/legal`. This is a `'use client'` module, and the address used to
 * be declared in the same file as ten sections of privacy policy and seven of terms — several
 * kilobytes of prose reachable from a client bundle to print one string. `lib/contact.ts` is
 * a handful of constants, and it is also the module a capability check is allowed to look at.
 */
import { DELETE_ACCOUNT_SUBJECT, SUPPORT_EMAIL, mailtoFor } from '@/lib/contact'
import { PageMasthead, PageBody } from '../page-shell'
import { ChangePassword } from '../change-password'
import { ExportCalendar } from '../export-calendar'
import { PasskeysSection } from '../passkeys-section'
import { ReissueRecoveryPhrase } from '../reissue-recovery-phrase'
import { SignOutButton } from '../sign-out-button'
import { TrashSection } from './trash-section'
import { SettingsSiblings } from './settings-doors'
import styles from './settings.module.css'

/**
 * /settings/security — password, recovery phrase, passkeys, devices, and your data.
 *
 * "SECURITY & DATA", not "Security". Export and the deletion route live here now, and both
 * are about getting your data out rather than keeping anyone else's hands off it. A door
 * labelled only Security is one nobody opens looking for their own calendar file, and export
 * spent months filed under Calendars for want of a better home.
 *
 * The page chrome lives HERE, not inside ChangePassword, which used to carry a lockup and an
 * <h1> of its own into whatever rendered it. One h1 per page, and the components below are
 * sections of it.
 */
export function SecurityScreen({
  demo,
  email,
  devices,
  billingEnabled,
}: {
  /**
   * The dev fixture, said OUT LOUD rather than inferred from an empty email.
   *
   * This branched on an empty email until it was pointed out that the sentinel had quietly
   * become load-bearing for a whole route: a signed-in user whose Supabase email is null
   * — phone auth, or an OAuth identity that returns none — would have been shown "Demo.
   * Sign in to manage your password" while signed in, with no way to tell that the page had
   * simply misread them. Two different facts were sharing one test.
   */
  demo: boolean
  email: string
  devices: readonly SettingsDevice[]
  billingEnabled: boolean
}) {
  const signedIn = !demo && email !== ''

  return (
    /* NARROW, now that the rail is gone. This page was forced wide to leave room for a 13rem
       scroll-spy column beside it; without one, 64rem of single-column form is the "narrow
       rail in a huge empty canvas" complaint rather than a use of the space. */
    <PageBody measure="narrow">
      <PageMasthead
        title="Security &amp; data"
        lede="Your password, your passkeys and your recovery phrase all open the same key. Changing any one of them re-wraps that key; none of them touches an event."
      />

      <main id="main" className={styles.sections}>
        {demo ? (
          /* The demo renders the Passkeys card too, disabled, and that is a TESTING decision
             as much as an honesty one. Every Playwright project runs in fixture mode, so a
             control that appears only for signed-in users is measured by nothing — not the
             axe scan on this page, not the 44px target sweep. Rendering it here, honestly
             disabled, is what puts it in front of both. */
          <>
            <p className={styles.lockedNote}>
              Demo. Sign in to manage your password and recovery phrase.
            </p>
            <PasskeysSection email={email} demo />
          </>
        ) : !signedIn ? (
          /* Signed in, but the account carries no email address. Not a demo and not a bug in
             this page: the email IS the KDF salt (see /account in CLAUDE.md), so there is
             genuinely nothing to derive a wrap key from, and both flows below would fail in a
             way that looks like a wrong password. Saying so is the only honest option until
             an account can be created without one. */
          <p className={styles.lockedNote}>
            This account has no email address on it. Your password and recovery phrase are
            both derived from it, so neither can be changed here. Get in touch and we will
            sort it out.
          </p>
        ) : (
          <>
            {/* Password first: it is the errand people come for. The phrase re-issue is the
                one they need and do not know exists, so it stays visible below rather than
                behind a menu. */}
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
                  Only this browser so far. Add a passkey above and your face, fingerprint or
                  device PIN opens your calendar, with the recovery phrase kept as the last
                  resort rather than the only one.
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
              {/* Stated beside the thing it is about, rather than in a roadmap footer on a
                  page two screens away. Pairing a device is built and tested in the crypto
                  and in the schema; what is missing is the flow, and passkeys answer the same
                  question without needing a second device at all. */}
              <p className={styles.rowNote}>
                Approving a new device from one you already trust is not built. A passkey
                covers the same ground on its own.
              </p>
            </section>
          </>
        )}

        {/*
          YOUR DATA — rendered in every branch, including the demo.

          Two reasons. Export works without an account, so hiding it from the fixture would
          hide the only control on this page a stranger can actually press. And axe only sees
          what is on screen: a control behind a sign-in is a control nothing measures, which
          is how a 2.99:1 Delete button once shipped.

          One h2 with two h3s, because these are one question — getting your data out, and
          getting rid of it — in the order the privacy policy already pairs them.
        */}
        <section className={styles.band}>
          <div className={styles.panelHead}>
            <h2 className={styles.panelTitle}>Your data</h2>
          </div>

          <div className={styles.subSection}>
            <h3 className={styles.subTitle}>Export</h3>
            {/* SAYS WHAT THE CONTROL DOES NOT. `ExportCalendar` carries its own note about the
                file format and about repeating events keeping their rule, directly under the
                button; a lede repeating both put the same two facts on screen twice, four
                lines apart. This says the part only the surrounding page can: where the file
                is built, and what it costs. */}
            <p className={styles.sectionLede}>
              Assembled in this browser from your own decrypted content, so it holds things our
              servers have never seen and it never goes back to them. Export is free
              permanently: charging to leave is not something a privacy product gets to do.
            </p>
            <ExportCalendar />
          </div>

          {/* BETWEEN export and account deletion, which is the order of consequence: getting a
              copy out, getting one thing back, getting rid of everything. "Trash" and never
              "Recently deleted" — nothing here expires, and a heading implying a window that
              does not exist is the export claim's mistake wearing a different sentence. */}
          <div className={styles.subSection}>
            <h3 className={styles.subTitle}>Trash</h3>
            <TrashSection demo={demo} />
          </div>

          <div className={styles.subSection}>
            <h3 className={styles.subTitle}>Deleting your account</h3>
            {/*
              A LINK, NOT A BUTTON, and the copy says why rather than leaving it a mystery.
              Nothing in this app can reach `auth.users`: rule 4 bans the service-role key and
              `security-posture.test.ts` bans SECURITY DEFINER, and `auth.users` has no RLS to
              scope a narrow role against — an `account_deleter` could destroy ANY account,
              inverting the very property ADR 0007 uses to justify `billing_writer`. So a
              control here would erase a calendar and leave an email address and a user id on
              file, which is a worse answer than this paragraph.
            */}
            <p className={styles.sectionLede}>
              Deleting your account is done by email, not by a button here. Write to us from
              the address you sign in with and we will erase every event, calendar, contact,
              rule and setting we hold for you. It cannot be undone.
            </p>
            <p className={styles.sectionLede}>
              There is no button because there could not be an honest one yet. Nothing in this
              app can reach the account record itself, so a control here would clear your
              calendar and leave your email address on file. We would rather say so than point
              you at something that only looks finished.
            </p>
            <p className={styles.rowNote}>
              <a className={styles.mailLink} href={mailtoFor(DELETE_ACCOUNT_SUBJECT)}>
                {SUPPORT_EMAIL}
              </a>
            </p>
            {/* A `mailto:` does nothing at all on a machine with no mail client registered,
                and it fails SILENTLY — the click simply does not land. This was the only route
                out of the product, so that failure was the whole flow. The contact page states
                the address as copyable text and carries the rest of the reasoning. */}
            <p className={styles.rowNote}>
              <Link className={styles.mailLink} href="/contact" prefetch={false}>
                Contact page
              </Link>
            </p>
          </div>
        </section>

        {signedIn && (
          <div>
            <SignOutButton />
          </div>
        )}
      </main>

      <SettingsSiblings current="security" billingEnabled={billingEnabled} />
    </PageBody>
  )
}
