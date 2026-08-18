'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { VisibilityRule } from '@cloakcal/policy'
import type { RedactedPage } from '@/server/audience'
import type { AudienceOption } from '@/lib/audiences'
import { supabaseBrowser } from '@/lib/supabase/client'
import { rpcErrorMessage } from '@/lib/rpc-error'
import { sealFields } from '@/lib/cloaked-fields'
import { CloakProvider, useCloakStore } from './cloak-provider'
import { useCloakedLabels } from './use-cloaked-labels'
import { CloakedText } from './cloaked-text'
import { Button, ButtonLink } from './ui/button'
import { InlineError } from './ui/inline-error'
import { VisibilityControl } from './visibility-control'
import { PeopleShell, audienceNamesOf } from './people-screen'
import { wallTimeLabel } from '@/lib/wall-time'
import styles from './contact-file.module.css'

/**
 * One contact's file: the whole person in one place. The preview that was always here —
 * the REAL redaction, run by the same engine and the same rules their genuine view runs,
 * with no second pipeline to drift from the truth (the lesson of Facebook's View As) —
 * plus everything that used to be scattered across two Settings cards: rename, group
 * membership, the visibility level, and removal.
 *
 * Names are ciphertext everywhere (ADR 0004), so renaming needs the calendar UNLOCKED
 * (sealing needs the key); membership, visibility and delete are id-only writes and stay
 * live while locked. Before unlock the file is titled `Contact 4f2a…`, which is what the
 * server actually sees.
 */

export function ContactFile({
  page,
  email,
  audiences,
  contactId,
  timezone,
  previewedAt,
  fixtureMode,
  workspaceId,
  workspaceRules,
  groupsByContact,
}: {
  page: RedactedPage
  email: string
  audiences: readonly AudienceOption[]
  contactId: string
  timezone: string
  previewedAt: string
  fixtureMode: boolean
  workspaceId: string | null
  workspaceRules: readonly VisibilityRule[]
  groupsByContact: Readonly<Record<string, readonly string[]>>
}) {
  const extraFields = useMemo(() => audienceNamesOf(audiences), [audiences])

  return (
    <CloakProvider page={page} email={email} extraFields={extraFields}>
      <PeopleShell back={{ href: '/people', label: 'People' }}>
        <ContactFileBody
          page={page}
          audiences={audiences}
          contactId={contactId}
          timezone={timezone}
          previewedAt={previewedAt}
          fixtureMode={fixtureMode}
          workspaceId={workspaceId}
          workspaceRules={workspaceRules}
          groupsByContact={groupsByContact}
        />
      </PeopleShell>
    </CloakProvider>
  )
}

function ContactFileBody({
  page,
  audiences,
  contactId,
  timezone,
  previewedAt,
  fixtureMode,
  workspaceId,
  workspaceRules,
  groupsByContact,
}: {
  page: RedactedPage
  audiences: readonly AudienceOption[]
  contactId: string
  timezone: string
  previewedAt: string
  fixtureMode: boolean
  workspaceId: string | null
  workspaceRules: readonly VisibilityRule[]
  groupsByContact: Readonly<Record<string, readonly string[]>>
}) {
  const router = useRouter()
  const store = useCloakStore()
  // The fixture unlocks with the dev key, so `unlocked` alone cannot gate demo writes;
  // fixtureMode is the explicit gate, the compose sheet's split (NewEvent.demo).
  const unlocked = store?.isUnlocked ?? false
  const canWrite = !fixtureMode && workspaceId !== null

  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirmingRemove, setConfirmingRemove] = useState(false)

  const option = audiences.find((a) => a.kind === 'individual' && a.id === contactId)
  const groups = audiences.filter((a) => a.kind === 'group')
  const names = useCloakedLabels('contact', [contactId], 'name')
  const groupNames = useCloakedLabels('contact_group', groups.map((g) => g.id), 'label')
  const name = names[contactId] ?? `Contact ${contactId.slice(0, 8)}…`
  const memberOf = groupsByContact[contactId] ?? []

  const run = async (action: () => Promise<void>) => {
    // The demo cannot write, structurally (no session, anon revoked); the early return
    // keeps that a property of the code rather than of a disabled attribute.
    if (!canWrite) return
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (caught) {
      setError(rpcErrorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  const rename = () =>
    run(async () => {
      if (store === null || workspaceId === null || renaming === null) return
      const value = renaming.trim()
      if (value === '') return
      // Same id, new sealed name: upsert_contact overwrites the `name` row. The AEAD
      // binds the ciphertext to the existing id, so the reseal targets it explicitly.
      const { error: rpcError } = await supabaseBrowser().rpc('upsert_contact', {
        p_contact_id: contactId,
        p_workspace_id: workspaceId,
        p_fields: await sealFields(store, 'contact', contactId, [['name', value]]),
      })
      if (rpcError !== null) throw rpcError
      setRenaming(null)
      router.refresh()
    })

  const toggleMember = (groupId: string, isMember: boolean) =>
    run(async () => {
      const supabase = supabaseBrowser()
      const { error: rpcError } = isMember
        ? await supabase.rpc('remove_group_member', {
            p_group_id: groupId,
            p_contact_id: contactId,
          })
        : await supabase.rpc('add_group_member', {
            p_group_id: groupId,
            p_contact_id: contactId,
          })
      if (rpcError !== null) throw rpcError
      router.refresh()
    })

  const remove = () =>
    run(async () => {
      const { error: rpcError } = await supabaseBrowser().rpc('delete_contact', {
        p_contact_id: contactId,
      })
      if (rpcError !== null) throw rpcError
      // The file no longer exists; the register is the only place left to stand.
      router.push('/people')
      router.refresh()
    })

  // Day names come from Date.UTC read back with getUTC*, the mini month's fixed-instant
  // pattern, which cannot drift with the host timezone.
  const dayOf = useMemo(() => {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      weekday: 'short',
      month: 'short',
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

      <div className={styles.fileTab} aria-hidden="true">
        Contact file
        <span className={styles.fileTabId}>{contactId.slice(0, 8)}</span>
      </div>

      <article className={styles.filePanel}>
        <div className={styles.fileHead}>
          {/* The h1 stays put while the rename row is open, so the page never loses its
              title and the heading outline never flickers. */}
          <h1 className={styles.fileName}>{name}</h1>
          {renaming === null && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || !canWrite || !unlocked}
              title={
                canWrite && !unlocked
                  ? 'Unlock your calendar first. Names are encrypted.'
                  : undefined
              }
              onClick={() => setRenaming(names[contactId] ?? '')}
            >
              Rename
            </Button>
          )}
        </div>

        {renaming !== null && (
          <div className={styles.controlsRow}>
            <input
              className={styles.renameInput}
              value={renaming}
              maxLength={120}
              autoFocus
              disabled={busy}
              aria-label="Contact name"
              onChange={(event) => setRenaming(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void rename()
                if (event.key === 'Escape') setRenaming(null)
              }}
            />
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button size="sm" busy={busy} disabled={renaming.trim() === ''} onClick={() => void rename()}>
              Save
            </Button>
          </div>
        )}

        <InlineError>{error}</InlineError>

        <section className={styles.fileSection}>
          <h2 className={styles.sectionTitle}>What they see</h2>
          <p className={styles.lede}>
            {total === 0
              ? 'Nothing on the calendar this week.'
              : page.occurrences.length === 0
                ? `Sees none of your ${total} ${total === 1 ? 'event' : 'events'} this week.`
                : `Sees ${page.occurrences.length} of your ${total} ${total === 1 ? 'event' : 'events'} this week.`}
            {/* No SEPARATE count sentence, matching every other preview surface
                (2026-08-18, see preview-bar.tsx).

                Being exact about what that does and does not achieve, because the line
                above makes the softer claim false: `total` is occurrences + withheld, so
                "Sees 3 of your 11 events this week" still lets a reader subtract. The count
                is not gone from this page, it is stated as disclosure rather than as
                concealment — which is the framing this page is for, and is why the sentence
                stays. What is gone is the second sentence that named the hidden number on
                its own. */}
          </p>

          {days.length === 0 ? (
            <p className={styles.empty}>A quiet week: nothing to show and nothing to hide.</p>
          ) : (
            days.map(([day, occurrences]) => (
              <div key={day} className={styles.daySection}>
                <h3 className={styles.dayHeading}>{dayOf(day)}</h3>
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
              </div>
            ))
          )}

          <div className={styles.fullPreview}>
            <ButtonLink
              variant="outline"
              size="sm"
              href={{ pathname: '/', query: { as: `contact:${contactId}` } }}
            >
              Open the full calendar as {name}
            </ButtonLink>
          </div>
        </section>

        <section className={styles.fileSection}>
          <h2 className={styles.sectionTitle}>Visibility</h2>
          <p className={styles.sectionLede}>
            What {name} sees of your events unless an event says otherwise. Changing it
            here changes the preview above and their real view together, because all three
            run the same rules.
          </p>
          <VisibilityControl
            option={option ?? { id: contactId, kind: 'individual' }}
            name={name}
            workspaceId={workspaceId}
            demo={fixtureMode}
            rules={workspaceRules}
            groupsByContact={groupsByContact}
          />
        </section>

        <section className={styles.fileSection}>
          <h2 className={styles.sectionTitle}>Groups</h2>
          {groups.length === 0 ? (
            <p className={styles.empty}>
              No groups yet. Create one on the People page, and one rule can cover several
              people at once.
            </p>
          ) : (
            groups.map((group) => {
              const isMember = memberOf.includes(group.id)
              return (
                <label key={group.id} className={styles.checkboxRow}>
                  <input
                    type="checkbox"
                    checked={isMember}
                    disabled={busy || !canWrite}
                    onChange={() => void toggleMember(group.id, isMember)}
                  />
                  {groupNames[group.id] ?? `Group ${group.id.slice(0, 8)}…`}
                </label>
              )
            })
          )}
        </section>

        <section className={styles.fileSection}>
          <h2 className={styles.sectionTitle}>Remove</h2>
          {confirmingRemove ? (
            <div className={styles.controlsRow}>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setConfirmingRemove(false)}
              >
                Keep
              </Button>
              <Button
                variant="danger"
                size="sm"
                busy={busy}
                disabled={!canWrite}
                onClick={() => void remove()}
              >
                Remove {name}
              </Button>
              <p className={styles.rowNote} role="alert">
                Also removes any visibility rules for this person. Your events stay yours.
              </p>
            </div>
          ) : (
            <div className={styles.controlsRow}>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setConfirmingRemove(true)}
              >
                Remove from your people
              </Button>
            </div>
          )}
        </section>

        {fixtureMode && (
          <p className={styles.demoNote}>Demo data. Sign in to change what people see.</p>
        )}
      </article>
    </>
  )
}
