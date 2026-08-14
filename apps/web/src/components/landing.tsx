import { CloakLockup } from './cloak-logo'
import { ButtonLink } from './ui/button'
import { Icon } from './ui/icons'
import { LandingDemo } from './landing-demo'
import { LandingReveal } from './landing-reveal'
import styles from './landing.module.css'

/**
 * The landing page — what `/` shows a visitor with no session. A Server Component with no
 * data behind it: nothing here is private, so nothing here needs a key, a fetch, or a
 * loading state. The two client islands (demo, reveals) are enhancement over complete
 * server HTML.
 *
 * THE COPY IS BOUND BY RULE 1: CloakCal is not zero-knowledge and must never be marketed
 * as such. The honesty ledger states, in our own words, exactly what the server can and
 * cannot read, and the hero demo draws the same boundary: the time cell never hides.
 *
 * DARK-COMMITTED. data-theme="dark" on the root scopes the dark semantic tokens to this
 * subtree regardless of the visitor's stored theme; dark is the marketing surface
 * (tokens.css header). The app keeps its own theme the moment they sign in.
 *
 * No em dashes in rendered copy, by decree. Commas and periods do the work.
 */
export function Landing() {
  return (
    <div className={styles.page} data-theme="dark">
      <header className={styles.header}>
        <CloakLockup size="sm" />
        {/* One action, because one action is what exists. A "Get started" button beside a
            page that announces it is not open yet is a contradiction a visitor has to
            resolve by clicking, and the answer is always no. */}
        <div className={styles.headerActions}>
          <ButtonLink variant="outline" size="sm" href="/sign-in">
            Sign in
          </ButtonLink>
        </div>
      </header>

      <main id="main" className={styles.main}>
        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            {/* Text, not a pill: the eyebrow matches the section kickers below, and ink on
                the page background is a contrast pair already pinned. A washed badge would
                need its composite re-measured for one word. */}
            <p className={styles.eyebrow}>Coming soon</p>
            <h1 className={styles.headline}>
              Not everything is for <em>everyone</em>.
            </h1>
            <p className={styles.sub}>
              CloakCal encrypts your events on your device, then shows each person exactly
              as much as you choose. Your client sees a meeting. Your colleagues see busy.
              Everyone else sees nothing.
            </p>
            <div className={styles.ctaRow}>
              <ButtonLink variant="outline" href="/sign-in">
                Sign in
              </ButtonLink>
            </div>
          </div>

          <div className={styles.heroDemo}>
            {/* No backdrop motif, deliberately: an oversized faded mark behind the card
                read as an accidental blob, and a watermark is its own kind of slop. The
                demo card carries this column alone. */}
            <LandingDemo />
          </div>
        </section>

        <LandingReveal>
          <section className={styles.how} aria-labelledby="how-title">
            <h2 id="how-title" className={styles.kicker}>
              How it works
            </h2>

            <article className={styles.step}>
              <span className={styles.stepNumber} aria-hidden="true">
                01
              </span>
              <div className={styles.stepBody}>
                <h3 className={styles.stepTitle}>
                  <Icon name="eye-off" size={18} />
                  Sealed before it leaves your hands
                </h3>
                <p className={styles.stepText}>
                  Titles, places, notes and guest lists are encrypted in your browser,
                  with keys made from your password. The words reach our servers as
                  ciphertext, and ciphertext is what we store.
                </p>
              </div>
            </article>

            <article className={styles.step}>
              <span className={styles.stepNumber} aria-hidden="true">
                02
              </span>
              <div className={styles.stepBody}>
                <h3 className={styles.stepTitle}>
                  <Icon name="eye-half" size={18} />
                  Different people, different amounts
                </h3>
                <p className={styles.stepText}>
                  Four levels for every person or group: full details, limited, busy,
                  hidden. Set a default per person, override per event, change your mind
                  any time.
                </p>
              </div>
            </article>

            <article className={styles.step}>
              <span className={styles.stepNumber} aria-hidden="true">
                03
              </span>
              <div className={styles.stepBody}>
                <h3 className={styles.stepTitle}>
                  <Icon name="eye" size={18} />
                  See exactly what they see
                </h3>
                <p className={styles.stepText}>
                  View As renders your calendar through the same rules a real visitor
                  gets. The same code, not a preview. If it says they see busy, they see
                  busy.
                </p>
              </div>
            </article>
          </section>
        </LandingReveal>

        <LandingReveal>
          <section className={styles.honesty} aria-labelledby="honesty-title">
            <div className={styles.honestyInner}>
              <h2 id="honesty-title" className={styles.honestyTitle}>
                What we can see, said plainly
              </h2>
              <div className={styles.honestyGrid}>
                <div className={styles.honestyCol}>
                  <h3 className={styles.honestyLabel}>Stored readable, on purpose</h3>
                  <ul className={styles.honestyList}>
                    <li>
                      <Icon name="clock" size={14} />
                      When events happen: times, durations, repeats
                    </li>
                    <li>
                      <Icon name="clock" size={14} />
                      Which calendar an event belongs to
                    </li>
                  </ul>
                </div>
                <div className={styles.honestyCol}>
                  <h3 className={styles.honestyLabel}>Stored encrypted, always</h3>
                  <ul className={styles.honestyList}>
                    <li>
                      <Icon name="eye-off" size={14} />
                      Titles, locations, and notes
                    </li>
                    <li>
                      <Icon name="eye-off" size={14} />
                      Who is attending
                    </li>
                    <li>
                      <Icon name="eye-off" size={14} />
                      Your contacts&apos; names and your groups&apos; labels
                    </li>
                  </ul>
                </div>
              </div>
              <p className={styles.honestyNote}>
                Times stay readable because reminders and busy checks need them to work.
                The promise is exact: <strong>other people cannot see your content</strong>.
                It is not &ldquo;we cannot see anything.&rdquo; A privacy product that
                overclaims is a privacy product that lies.
              </p>
            </div>
          </section>
        </LandingReveal>

        <LandingReveal>
          <section className={styles.closing}>
            <h2 className={styles.closingTitle}>Your time. Your business.</h2>
            {/* The page closes on a statement rather than a button, for the same reason
                the hero does. There is nothing to sign up for yet, and saying when there
                will be is more use than a control that refuses. */}
            <p className={styles.closingNote}>
              CloakCal is still being built. New accounts open soon.
            </p>
          </section>
        </LandingReveal>
      </main>

      <footer className={styles.footer}>
        <span>CloakCal</span>
        <span aria-hidden="true">·</span>
        <span>Encrypted on your device. Shared on your terms.</span>
      </footer>
    </div>
  )
}
