'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import type { RedactedPage } from '@/server/audience'
import type { AudienceOption } from '@/lib/audiences'
import { CloakProvider, type ExtraSealedField } from './cloak-provider'
import { useCloakedLabels } from './use-cloaked-labels'
import { CloakedText } from './cloaked-text'
import { CloakLockup } from './cloak-logo'
import { ButtonLink } from './ui/button'
import { wallTimeLabel } from '@/lib/wall-time'
import styles from './people-screen.module.css'

/**
 * The People area: a list of everyone with a view into this calendar, and a page per
 * contact answering the only question that matters — what does this person actually see.
 *
 * The preview is the REAL redaction: the server ran the same engine and the same rules it
 * runs when this contact genuinely loads a booked view, and this component just renders
 * the result. There is no second "preview" pipeline to drift from the truth — the same
 * reasoning that keeps rule 3 alive, and the lesson of Facebook's View As, which was a
 * separate path until it became the breach.
 *
 * Names are ciphertext everywhere (ADR 0004), so both screens decrypt them client-side
 * exactly as ViewAsBar does. Before unlock they show the server's honest view:
 * `Contact 4f2a…`.
 */

const audienceNamesOf = (audiences: readonly AudienceOption[]): readonly ExtraSealedField[] =>
  audiences.flatMap((option) =>
    option.nameField === undefined
      ? []
      : [
          {
            subjectType: option.kind === 'group' ? ('contact_group' as const) : ('contact' as const),
            subjectId: option.id,
            field: option.nameField,
          },
        ],
  )

function PeopleShell({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <CloakLockup size="sm" />
        <Link className={styles.backLink} href={{ pathname: '/' }}>
          Back to calendar
        </Link>
      </header>
      <main id="main" className={styles.main}>
        {children}
      </main>
    </div>
  )
}

export function PeopleList({
  page,
  email,
  audiences,
  fixtureMode,
}: {
  page: RedactedPage
  email: string
  audiences: readonly AudienceOption[]
  fixtureMode: boolean
}) {
  const extraFields = useMemo(() => audienceNamesOf(audiences), [audiences])

  return (
    <CloakProvider page={page} email={email} extraFields={extraFields}>
      <PeopleShell>
        <PeopleListBody audiences={audiences} fixtureMode={fixtureMode} />
      </PeopleShell>
    </CloakProvider>
  )
}

function PeopleListBody({
  audiences,
  fixtureMode,
}: {
  audiences: readonly AudienceOption[]
  fixtureMode: boolean
}) {
  const contacts = audiences.filter((a) => a.kind === 'individual')
  const groups = audiences.filter((a) => a.kind === 'group')
  const contactNames = useCloakedLabels('contact', contacts.map((a) => a.id), 'name')
  const groupNames = useCloakedLabels('contact_group', groups.map((a) => a.id), 'label')

  return (
    <>
      <h1 className={styles.title}>People</h1>
      <p className={styles.lede}>
        Everyone you can show a different amount of your calendar to. Open someone to see
        your week exactly as they would.
      </p>

      {contacts.length === 0 ? (
        <p className={styles.empty}>
          {fixtureMode
            ? 'Demo data has no contacts of its own. Sign in to add people.'
            : 'No people yet. Add someone in Settings, then decide what they see.'}
        </p>
      ) : (
        <ul className={styles.list}>
          {contacts.map((contact) => (
            <li key={contact.id}>
              <Link className={styles.personRow} href={{ pathname: `/people/${contact.id}` }}>
                <span className={styles.personName}>
                  {contactNames[contact.id] ?? `Contact ${contact.id.slice(0, 8)}…`}
                </span>
                <span className={styles.personAction} aria-hidden="true">
                  What they see ›
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {groups.length > 0 && (
        <>
          <h2 className={styles.groupHeading}>Groups</h2>
          {/* Groups have no page of their own yet: a group's view is what its members
              get, and each member's page shows it. Listing them names the audience the
              rules can point at. */}
          <ul className={styles.list}>
            {groups.map((group) => (
              <li key={group.id} className={styles.groupRow}>
                {groupNames[group.id] ?? `Group ${group.id.slice(0, 8)}…`}
              </li>
            ))}
          </ul>
        </>
      )}

      <p className={styles.settingsNote}>
        Add or remove people, and change what each person sees, in{' '}
        <Link href={{ pathname: '/settings', hash: 'people' }}>Settings</Link>.
      </p>
    </>
  )
}

export function ContactPreview({
  page,
  email,
  audiences,
  contactId,
  timezone,
  previewedAt,
  fixtureMode,
}: {
  page: RedactedPage
  email: string
  audiences: readonly AudienceOption[]
  contactId: string
  timezone: string
  previewedAt: string
  fixtureMode: boolean
}) {
  const extraFields = useMemo(() => audienceNamesOf(audiences), [audiences])

  return (
    <CloakProvider page={page} email={email} extraFields={extraFields}>
      <PeopleShell>
        <ContactPreviewBody
          page={page}
          contactId={contactId}
          timezone={timezone}
          previewedAt={previewedAt}
          fixtureMode={fixtureMode}
        />
      </PeopleShell>
    </CloakProvider>
  )
}

function ContactPreviewBody({
  page,
  contactId,
  timezone,
  previewedAt,
  fixtureMode,
}: {
  page: RedactedPage
  contactId: string
  timezone: string
  previewedAt: string
  fixtureMode: boolean
}) {
  const names = useCloakedLabels('contact', [contactId], 'name')
  const name = names[contactId] ?? `Contact ${contactId.slice(0, 8)}…`

  // Day names come from Date.UTC read back with getUTC*, the mini month's fixed-instant
  // pattern, which cannot drift with the host timezone.
  const dayOf = useMemo(() => {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    })
    return (day: string) => {
      const [y, m, d] = day.split('-').map(Number)
      return fmt.format(new Date(Date.UTC(y!, m! - 1, d!)))
    }
  }, [])

  // Grouped by the LOCAL day of the occurrence, which the server already computed.
  const days = useMemo(() => {
    const byDay = new Map<string, typeof page.occurrences extends readonly (infer T)[] ? T[] : never>()
    for (const occurrence of page.occurrences) {
      const day = occurrence.occurrenceLocal.slice(0, 10)
      const bucket = byDay.get(day)
      if (bucket === undefined) byDay.set(day, [occurrence])
      else bucket.push(occurrence)
    }
    return [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
  }, [page.occurrences])

  const total = page.occurrences.length + page.withheldCount
  const when = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(previewedAt))

  return (
    <>
      {/* The preview banner is viewport-level chrome, not a badge: the risk with any
          "view as" surface is mistaking the preview for the calendar days later, so the
          frame says whose eyes these are and when the answer was computed. */}
      <div className={styles.previewBanner} role="status">
        <span>
          This is what <strong>{name}</strong> sees, as of {when}.
        </span>
        <Link className={styles.previewExit} href={{ pathname: '/people' }}>
          Exit preview
        </Link>
      </div>

      <h1 className={styles.title}>{name}</h1>
      <p className={styles.lede}>
        {total === 0
          ? 'Nothing on the calendar this week.'
          : page.occurrences.length === 0
            ? `Sees none of your ${total} ${total === 1 ? 'event' : 'events'} this week.`
            : `Sees ${page.occurrences.length} of your ${total} ${total === 1 ? 'event' : 'events'} this week.`}
        {page.withheldCount > 0 &&
          ` ${page.withheldCount} ${page.withheldCount === 1 ? 'is' : 'are'} hidden from them entirely.`}
      </p>

      {days.length === 0 ? (
        <p className={styles.empty}>A quiet week: nothing to show and nothing to hide.</p>
      ) : (
        days.map(([day, occurrences]) => (
          <section key={day} className={styles.daySection}>
            <h2 className={styles.dayHeading}>{dayOf(day)}</h2>
            <ul className={styles.eventList}>
              {occurrences.map((occurrence) => (
                <li
                  key={`${occurrence.eventId}-${occurrence.occurrenceLocal}`}
                  className={styles.eventRow}
                >
                  <span className={styles.eventTime}>{wallTimeLabel(occurrence.start)}</span>
                  {occurrence.time === 'busy' ? (
                    // The server sent no fields for this one: Busy is the whole story.
                    <span className={styles.eventTitle}>Busy</span>
                  ) : (
                    <CloakedText
                      className={styles.eventTitle}
                      subjectType="event"
                      subjectId={occurrence.eventId}
                      fieldName="title"
                      placeholder="Private event"
                    />
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      <p className={styles.settingsNote}>
        {fixtureMode ? (
          'Demo data. Sign in to change what people see.'
        ) : (
          <>
            Change what {name} sees in <Link href={{ pathname: '/settings', hash: 'visibility' }}>Settings</Link>.
            Changing it there changes it here, because this page and their real view run
            the same rules.
          </>
        )}
      </p>

      <div className={styles.fullPreview}>
        <ButtonLink
          variant="outline"
          size="sm"
          href={{ pathname: '/', query: { as: `contact:${contactId}` } }}
        >
          Open the full calendar as {name}
        </ButtonLink>
      </div>
    </>
  )
}
