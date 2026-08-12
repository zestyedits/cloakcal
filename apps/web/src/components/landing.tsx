import { CloakLockup } from './cloak-logo'
import { ButtonLink } from './ui/button'
import { Icon } from './ui/icons'
import { PrivacyChip } from './ui/privacy-chip'
import styles from './landing.module.css'

/**
 * The landing page — what `/` shows a visitor with no session. A Server Component with no
 * data behind it: nothing here is private, so nothing here needs a key, a fetch, or a
 * loading state.
 *
 * THE COPY IS BOUND BY RULE 1: CloakCal is not zero-knowledge and must never be marketed
 * as such. The honesty block states, in our own words, exactly what the server can and
 * cannot read — overclaiming is how privacy products lie, and a bounded claim is the only
 * kind this product is allowed to make.
 *
 * The demo panel is the pitch drawn instead of described: one event, three audiences,
 * three different amounts. Static markup with invented content — no real data exists on
 * this page to leak.
 */
export function Landing() {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <CloakLockup size="sm" />
        <div className={styles.headerActions}>
          <ButtonLink variant="ghost" size="sm" href="/sign-in">
            Sign in
          </ButtonLink>
          <ButtonLink variant="primary" size="sm" href="/sign-up">
            Get started
          </ButtonLink>
        </div>
      </header>

      <main id="main" className={styles.main}>
        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <h1 className={styles.headline}>
              Not everything is for <em>everyone</em>.
            </h1>
            <p className={styles.sub}>
              CloakCal is a calendar that encrypts your events on your device — and lets
              you show different people different amounts of the same event. Your client
              sees a meeting. Your colleagues see busy. Everyone else sees nothing.
            </p>
            <div className={styles.ctaRow}>
              <ButtonLink variant="primary" href="/sign-up">
                Create your calendar
              </ButtonLink>
              <ButtonLink variant="outline" href="/sign-in">
                Sign in
              </ButtonLink>
            </div>
          </div>

          {/* One event, three audiences. */}
          <div className={styles.demo} aria-label="The same event, seen by three audiences">
            <div className={styles.demoCard}>
              <span className={styles.demoWho}>You see</span>
              <div className={styles.demoRow}>
                <span className={styles.demoTime}>2:00 PM</span>
                <span className={styles.demoTitle}>Legal call — custody</span>
                <span className={styles.demoDetail}>Conference Rm B</span>
              </div>
            </div>
            <div className={styles.demoCard}>
              <span className={styles.demoWho}>Your client sees</span>
              <div className={styles.demoRow}>
                <span className={styles.demoTime}>2:00 PM</span>
                <span className={styles.demoTitle}>Legal call</span>
                <PrivacyChip level="limited" />
              </div>
            </div>
            <div className={styles.demoCard}>
              <span className={styles.demoWho}>Everyone else sees</span>
              <div className={styles.demoRow} data-muted="true">
                <span className={styles.demoTime}>2:00 PM</span>
                <span className={styles.demoTitle}>Busy</span>
                <PrivacyChip level="busy" />
              </div>
            </div>
          </div>
        </section>

        <section className={styles.features} aria-label="How CloakCal works">
          <article className={styles.feature}>
            <span className={styles.featureIcon} aria-hidden="true">
              <Icon name="eye-off" size={22} />
            </span>
            <h2 className={styles.featureTitle}>Sealed before it leaves your hands</h2>
            <p className={styles.featureBody}>
              Titles, places, notes and guest lists are encrypted on your device, with keys
              made from your password. What reaches our servers is unreadable — to anyone,
              including us.
            </p>
          </article>
          <article className={styles.feature}>
            <span className={styles.featureIcon} aria-hidden="true">
              <Icon name="eye-half" size={22} />
            </span>
            <h2 className={styles.featureTitle}>Different people, different amounts</h2>
            <p className={styles.featureBody}>
              Four levels for every person or group: full details, limited, busy, hidden.
              Set a default per person, override per event, change your mind any time.
            </p>
          </article>
          <article className={styles.feature}>
            <span className={styles.featureIcon} aria-hidden="true">
              <Icon name="eye" size={22} />
            </span>
            <h2 className={styles.featureTitle}>See exactly what they see</h2>
            <p className={styles.featureBody}>
              View As renders your calendar through the same rules a real visitor gets —
              the same code, not a preview. If it says they see busy, they see busy.
            </p>
          </article>
        </section>

        <section className={styles.honesty} aria-labelledby="honesty-title">
          <h2 id="honesty-title" className={styles.honestyTitle}>
            What we can see, said plainly
          </h2>
          <div className={styles.honestyGrid}>
            <div className={styles.honestyCol}>
              <h3 className={styles.honestyLabel}>Stored readable, on purpose</h3>
              <ul className={styles.honestyList}>
                <li>When events happen — times, durations, repeats</li>
                <li>Which calendar an event belongs to</li>
              </ul>
            </div>
            <div className={styles.honestyCol}>
              <h3 className={styles.honestyLabel}>Stored encrypted, always</h3>
              <ul className={styles.honestyList}>
                <li>Titles, locations, and notes</li>
                <li>Who is attending</li>
                <li>Your contacts&apos; names and your groups&apos; labels</li>
              </ul>
            </div>
          </div>
          <p className={styles.honestyNote}>
            Times stay readable because reminders and busy-checks need them to work. The
            promise is exact: <strong>other people cannot see your content</strong> — not
            &ldquo;we cannot see anything.&rdquo; A privacy product that overclaims is a
            privacy product that lies.
          </p>
        </section>

        <section className={styles.closing}>
          <h2 className={styles.closingTitle}>Your time. Your business.</h2>
          <div className={styles.ctaRow}>
            <ButtonLink variant="primary" href="/sign-up">
              Create your calendar
            </ButtonLink>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <span>CloakCal</span>
        <span aria-hidden="true">·</span>
        <span>Encrypted on your device. Shared on your terms.</span>
      </footer>
    </div>
  )
}
