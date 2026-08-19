import Link from 'next/link'
import { DELETE_ACCOUNT_SUBJECT, SUPPORT_EMAIL, mailtoFor } from '@/lib/contact'
import { PageMasthead, PageShell } from './page-shell'
import styles from './contact.module.css'

/**
 * /contact — one address, who reads it, and what it cannot do.
 *
 * A SERVER COMPONENT WITH NO CLIENT JAVASCRIPT AND NO SESSION READ, which is most of why this
 * answer was chosen over a form. There is nothing here to hydrate, nothing to rate limit,
 * nothing to store and no endpoint to defend. `lib/contact.ts` carries the full argument.
 *
 * THE ORDER OF THE SECTIONS IS THE DESIGN. The address comes first because that is what
 * somebody arrived for. What we cannot do comes SECOND, ahead of everything friendlier,
 * because the single most likely reason a stranger writes to a product like this one is that
 * they have lost their password, and the honest answer is that no amount of email fixes it.
 * Burying that under a warm paragraph would cost somebody a day of hoping.
 *
 * NOTHING HERE PROMISES A RESPONSE TIME, A QUEUE, OR A SUPPORT TEAM, and the copy says why
 * rather than being quietly silent about it. "We aim to reply within 24 hours" is the sentence
 * every product this size writes and none of them can keep; an unkept promise on the page whose
 * whole job is being believed is worse than an admission.
 *
 * THE ADDRESS IS THE LINK'S OWN TEXT, on purpose, and it is the one mechanical decision on the
 * page. A `mailto:` does nothing at all on a machine with no mail client registered, which is
 * most webmail users on a desktop, and the failure is silent — the click just does not land.
 * Rendering the address as the label means select-and-copy works even when the click does not,
 * and the sentence under it says so out loud rather than leaving somebody stuck.
 */
export function ContactScreen() {
  return (
    <PageShell back={{ href: '/', label: 'CloakCal' }} measure="narrow">
      <PageMasthead
        title="Contact"
        lede="One address, who reads it, and the things writing to it cannot fix."
      />

      <main id="main" className={styles.body}>
        <section className={styles.section} aria-labelledby="address">
          <h2 id="address" className={styles.heading}>
            The address
          </h2>
          <p className={styles.address}>
            <a className={styles.addressLink} href={mailtoFor('CloakCal')}>
              {SUPPORT_EMAIL}
            </a>
          </p>
          <p className={styles.paragraph}>
            That is the whole contact surface. If the link does not open anything, the address
            above is ordinary selectable text, so copy it into whatever you already use for
            mail.
          </p>
          <p className={styles.paragraph}>
            There is no form here, and it is not an unfinished page. A form would put what you
            typed onto our servers before a person ever read it, which is one more copy of your
            words in the clear, in a place you did not pick. Your own mail client does the job
            without any of that, and it leaves you holding a copy of what you sent.
          </p>
        </section>

        <section className={styles.section} aria-labelledby="cannot">
          <h2 id="cannot" className={styles.heading}>
            What writing to us cannot do
          </h2>
          <p className={styles.paragraph}>
            We cannot get your calendar back. Not as a policy, as a fact: your password and
            your recovery phrase never reach us in a form we could use. If you have lost both
            and have no passkey registered, your events are unreadable to everyone including
            us, and there is no escalation, no override and no exception that changes it.
          </p>
          <p className={styles.paragraph}>
            So please never send us your password or your recovery phrase. There is nothing we
            could do with either except be somewhere they leaked from.
          </p>
        </section>

        <section className={styles.section} aria-labelledby="expect">
          <h2 id="expect" className={styles.heading}>
            What to expect
          </h2>
          <p className={styles.paragraph}>
            CloakCal is one person. There is no support team, no ticket queue and no rota, and
            you will not find a response time on this page. Every product this size publishes
            one and most of them cannot keep it, and a promise we would break is worth less to
            you than this sentence.
          </p>
          <p className={styles.paragraph}>
            What is true is that mail to that address goes to a person rather than into a
            system, and that we would rather hear about something broken than not.
          </p>
        </section>

        <section className={styles.section} aria-labelledby="in-the-clear">
          <h2 id="in-the-clear" className={styles.heading}>
            Email is not the calendar
          </h2>
          <p className={styles.paragraph}>
            Your event content is encrypted in your browser before it reaches us. An email is
            not. Anything you write arrives readable, and it is readable to your mail provider,
            to ours, and to us. That is how email works everywhere, and it is worth saying here
            because choosing this product is a reason to assume otherwise.
          </p>
          <p className={styles.paragraph}>
            The practical version: describe the problem rather than pasting the thing. We can
            almost always work from &ldquo;an event on Tuesday morning will not save&rdquo;
            without ever learning what it was.
          </p>
          <p className={styles.paragraph}>
            Where the message ends up, how long it is kept and who else handles it are in the{' '}
            <Link className={styles.inlineLink} href="/privacy#writing-to-us">
              privacy policy
            </Link>
            , under &ldquo;If you write to us&rdquo;.
          </p>
        </section>

        <section className={styles.section} aria-labelledby="deletion">
          <h2 id="deletion" className={styles.heading}>
            Deleting your account
          </h2>
          {/*
            THE ONE THING THIS ADDRESS IS LOAD-BEARING FOR, so it gets its own heading rather
            than a line in a list. Nothing in the app can reach `auth.users`: rule 4 bans the
            service-role key and `security-posture.test.ts` bans SECURITY DEFINER, so a button
            here would clear a calendar and leave an email address and a user id on file.

            "From the address you sign in with" is not paperwork. It is the ONLY authentication
            available for a request that is irreversible, and it is a stronger one than a form
            with an email field, which is free text anybody can type. That inversion is the
            single most counterintuitive thing about choosing a mailto here, so it is stated
            for the reader rather than left as a rule that reads like friction.
          */}
          <p className={styles.paragraph}>
            Deletion is done by email rather than by a button, because nothing in this app can
            reach the account record itself. A control here would clear your calendar and leave
            your email address on file, which is a worse answer than this paragraph.
          </p>
          <p className={styles.paragraph}>
            Write from the address you sign in with. That is the only proof we have that the
            request is yours, and it is why we will not act on one sent from anywhere else.
          </p>
          <p className={styles.paragraph}>
            <a className={styles.actionLink} href={mailtoFor(DELETE_ACCOUNT_SUBJECT)}>
              Start a deletion request
            </a>
          </p>
        </section>

        <section className={styles.section} aria-labelledby="security">
          <h2 id="security" className={styles.heading}>
            Reporting something you found
          </h2>
          {/*
            A privacy product with no disclosure route is a privacy product hoping nobody
            looks. Deliberately modest: no bounty, no scope document, no triage window, because
            none of those exist and inventing them is the same class of overclaim as the export
            sentence that sat false in the privacy policy for months.
          */}
          <p className={styles.paragraph}>
            Same address, with the word security in the subject so it does not sit behind
            anything else. There is no bounty programme and no disclosure timeline to quote at
            you. There is one person who would much rather know.
          </p>
          <p className={styles.paragraph}>
            <a className={styles.actionLink} href={mailtoFor('Security')}>
              Report a security issue
            </a>
          </p>
        </section>

        <p className={styles.footNote}>
          <Link className={styles.inlineLink} href="/privacy">
            Privacy policy
          </Link>
          <span aria-hidden="true"> · </span>
          <Link className={styles.inlineLink} href="/terms">
            Terms of service
          </Link>
        </p>
      </main>
    </PageShell>
  )
}
