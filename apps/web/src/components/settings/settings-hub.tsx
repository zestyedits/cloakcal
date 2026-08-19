import Link from 'next/link'
import type { SettingsSummary } from '@/lib/settings-sections'
import { PageMasthead, PageShell } from '../page-shell'
import { SettingsDoors } from './settings-doors'
import { LegacyHashForward } from './legacy-hash-forward'
import styles from './settings-hub.module.css'

/**
 * /settings — four doors, and nothing else.
 *
 * This replaced a seven-card accordion sitting under a four-figure readout band and above a
 * roadmap footer. The complaint that started it was that the page was organised like an
 * internal control panel rather than a private control centre, and the readout was the
 * clearest case: "02 calendars / 01 people / 01 rules" at display size is telemetry, not a
 * decision anybody was about to make. Every figure it printed is now a phrase on the door
 * you would press to change it.
 *
 * NO `CloakProvider`, AND IT MUST STAY THAT WAY. This page renders no calendar name, no
 * contact name and no group label — every one of those is ciphertext, and opening them needs
 * a key vault, an IndexedDB read and a client bundle, on a page of four links. The loader is
 * head counts only for exactly this reason. If a friendlier summary is ever wanted, the two
 * wrong ways to get it are re-adding the provider and asking the server for a name it
 * structurally cannot read; see rule 2.
 */
export function SettingsHub({
  summaries,
  fixtureMode,
  billingEnabled,
}: {
  summaries: SettingsSummary | null
  fixtureMode: boolean
  /**
   * Resolved by the page, never read here, so this component and the loading fallback draw
   * the same number of rows. A skeleton of four settling to three is a visible jump on the
   * one page whose fallback was hand-built to avoid exactly that.
   */
  billingEnabled: boolean
}) {
  return (
    <PageShell back={{ href: '/', label: 'Calendar' }}>
      <LegacyHashForward />
      <PageMasthead
        title="Settings"
        lede="What is true about your account right now, and what you can change safely."
      />

      <main id="main" className={styles.hub}>
        <SettingsDoors
          summaries={summaries}
          fixtureMode={fixtureMode}
          billingEnabled={billingEnabled}
        />

        {/* Reachable from inside the account as well as from the landing footer. Someone
            deciding whether to trust the product reads these before signing up; someone
            deciding whether to keep trusting it reads them after, and should not have to
            sign out to find them.

            "Privacy policy", not "Privacy". There is a door called Privacy on this page, and
            `getByRole('link', { name })` matches a SUBSTRING — two links whose names differ
            only by a word nobody says out loud is an ambiguity in the test suite and a real
            one for anyone navigating by link list. */}
        <p className={styles.legalRow}>
          <Link href="/privacy">Privacy policy</Link>
          <Link href="/terms">Terms of service</Link>
          {/* "Contact us", not "Contact". There is no door named Contact on this page today,
              but the substring rule that forced "Privacy policy" is a property of the whole
              link list rather than of one collision, and a one-word link is the one most
              likely to collide with a future door. */}
          {/* `prefetch={false}` for the reason stated in full in `legal-footer.tsx`: a
              footer link is in the viewport on load, so this would fetch a rarely-opened
              route on every visit to the settings hub. */}
          <Link href="/contact" prefetch={false}>
            Contact us
          </Link>
        </p>
      </main>
    </PageShell>
  )
}
