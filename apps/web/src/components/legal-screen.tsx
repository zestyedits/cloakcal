import type { LegalDocument } from '@/lib/legal'
import { PageMasthead, PageShell } from './page-shell'
import styles from './legal.module.css'

/**
 * The privacy policy and the terms, rendered from `lib/legal.ts`.
 *
 * ONE COMPONENT FOR BOTH, because they are the same shape — a masthead, a date, and a
 * sequence of headed sections — and two near-identical screens would drift the moment one of
 * them got a tweak. The documents differ in words, not in structure.
 *
 * A SERVER COMPONENT, deliberately. There is nothing interactive here, so shipping this as a
 * client component would put several kilobytes of legal prose into the JavaScript bundle to
 * render text that never changes.
 *
 * Back goes to `/` rather than to Settings: these pages are reachable signed OUT, and the
 * first person to read them is a stranger deciding whether to trust the product. Sending them
 * to a calendar they do not have would be a dead end.
 */
export function LegalScreen({ document }: { document: LegalDocument }) {
  return (
    <PageShell back={{ href: '/', label: 'CloakCal' }} measure="narrow">
      <PageMasthead title={document.title} lede={document.lede} />

      <main id="main" className={styles.body}>
        {/*
          The date sits above the contents rather than in a footer. A reader who wants to know
          whether a policy is current wants that before they read it, not after.
        */}
        <p className={styles.updated}>Last updated {document.updated}</p>

        {/*
          A table of contents, because the privacy policy has ten sections and the one people
          actually arrive looking for is usually "what can you see" or "how do I delete this".
          Anchors, so a link can point at a section from Settings or from an email.
        */}
        <nav className={styles.contents} aria-label={`${document.title} sections`}>
          <ol>
            {document.sections.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`}>{section.heading}</a>
              </li>
            ))}
          </ol>
        </nav>

        {document.sections.map((section) => (
          <section key={section.id} id={section.id} className={styles.section}>
            <h2 className={styles.heading}>{section.heading}</h2>
            {section.body.map((paragraph) => (
              <p key={paragraph.slice(0, 40)} className={styles.paragraph}>
                {paragraph}
              </p>
            ))}
            {section.list !== undefined && (
              <ul className={styles.list}>
                {section.list.map((item) => (
                  <li key={item.slice(0, 40)}>{item}</li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </main>
    </PageShell>
  )
}
