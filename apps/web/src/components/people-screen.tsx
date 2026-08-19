'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import type { Route } from 'next'
import { useRouter } from 'next/navigation'
import { decisionToLevel, type VisibilityRule } from '@cloakcal/policy'
import type { RedactedPage } from '@/server/audience'
import type { AudienceOption } from '@/lib/audiences'
import { supabaseBrowser } from '@/lib/supabase/client'
import { rpcErrorMessage } from '@/lib/rpc-error'
import { sealFields } from '@/lib/cloaked-fields'
import { CloakProvider, useCloakStore, type ExtraSealedField } from './cloak-provider'
import { useCloakedLabels } from './use-cloaked-labels'
import { PageMasthead, PageShell } from './page-shell'
import { workspaceDecisionFor } from './visibility-control'
import { PrivacyChip } from './ui/privacy-chip'
import { Button } from './ui/button'
import { InlineError } from './ui/inline-error'
import styles from './people-screen.module.css'

/**
 * The People register: the contact book itself, not a read-only view over a Settings form.
 * Contacts and groups are added, organized and removed HERE — the management moved out of
 * the Settings People card (which is now a pointer into this book), and each contact's
 * file at /people/[contactId] answers the only question that matters: what does this
 * person actually see.
 *
 * Styling is the restrained file room: raised panels under hairline rules, monospace
 * accents for the ids the server actually knows people by, and nothing skeuomorphic. The
 * vocabulary does not change — Full details / Limited / Busy / Hidden mean the same thing
 * here as everywhere else.
 *
 * Names are ciphertext everywhere (ADR 0004), so adding and renaming need the calendar
 * UNLOCKED (sealing needs the key) and disable honestly when it is not. Before unlock the
 * list shows `Contact 4f2a…` — the server's honest view, same as the View As picker.
 */

export const audienceNamesOf = (
  audiences: readonly AudienceOption[],
): readonly ExtraSealedField[] =>
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

export function PeopleShell({
  children,
  masthead,
  back = { href: '/', label: 'Calendar' },
}: {
  children: React.ReactNode
  /** Sits OUTSIDE <main>, matching the settings pages — /people had its h1 inside. */
  masthead?: React.ReactNode
  /** Where "up" goes. A contact's file goes back to the register, not past it. */
  back?: { href: Route; label: string }
}) {
  return (
    /* NARROW throughout now. /people used to be forced wide to leave room for the settings
       rail beside it; the rail is gone, and a register at 64rem is a line-length problem
       rather than a use of the space. Its way up is still the door it was opened from. */
    <PageShell back={back} measure="narrow">
      {masthead}
      <main id="main" className={styles.main}>
        {children}
      </main>
    </PageShell>
  )
}

/** Two-digit register count, in the file room's monospace. */
const registerCount = (n: number): string => String(n).padStart(2, '0')

export function PeopleList({
  page,
  email,
  audiences,
  fixtureMode,
  workspaceId,
  workspaceRules,
  groupsByContact,
  now,
}: {
  page: RedactedPage
  email: string
  audiences: readonly AudienceOption[]
  fixtureMode: boolean
  workspaceId: string | null
  /** Workspace defaults, so a register row can say what this person currently gets. */
  workspaceRules: readonly VisibilityRule[]
  groupsByContact: Readonly<Record<string, readonly string[]>>
  now: string
}) {
  const extraFields = useMemo(() => audienceNamesOf(audiences), [audiences])

  return (
    <CloakProvider page={page} email={email} extraFields={extraFields}>
      <PeopleShell
        masthead={
          <PageMasthead
            title="People"
            lede="Everyone you can show a different amount of your calendar to. Each person has a file: open it to see your week exactly as they would, and to decide what they get."
          />
        }
      >
        <PeopleListBody
          audiences={audiences}
          fixtureMode={fixtureMode}
          workspaceId={workspaceId}
          workspaceRules={workspaceRules}
          groupsByContact={groupsByContact}
          now={now}
        />
      </PeopleShell>
    </CloakProvider>
  )
}

function PeopleListBody({
  audiences,
  fixtureMode,
  workspaceId,
  workspaceRules,
  groupsByContact,
  now,
}: {
  audiences: readonly AudienceOption[]
  fixtureMode: boolean
  workspaceId: string | null
  workspaceRules: readonly VisibilityRule[]
  groupsByContact: Readonly<Record<string, readonly string[]>>
  now: string
}) {
  const router = useRouter()
  const store = useCloakStore()
  // The fixture unlocks with the dev key, so `unlocked` alone cannot gate demo writes;
  // fixtureMode is the explicit gate, same split the compose sheet drew (NewEvent.demo).
  const unlocked = store?.isUnlocked ?? false
  const canWrite = !fixtureMode && workspaceId !== null

  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<{ kind: 'contact' | 'group'; value: string } | null>(null)
  const [confirmingGroup, setConfirmingGroup] = useState<string | null>(null)

  const contacts = audiences.filter((a) => a.kind === 'individual')
  const groups = audiences.filter((a) => a.kind === 'group')
  const contactNames = useCloakedLabels('contact', contacts.map((a) => a.id), 'name')
  const groupNames = useCloakedLabels('contact_group', groups.map((a) => a.id), 'label')

  const run = async (action: () => Promise<void>) => {
    // The demo cannot write, structurally (no session, anon revoked); the early return
    // keeps that a property of the code rather than of a disabled attribute.
    if (!canWrite) return
    setBusy(true)
    setError(null)
    try {
      await action()
      router.refresh()
    } catch (caught) {
      setError(rpcErrorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  const add = () =>
    run(async () => {
      if (draft === null || store === null || workspaceId === null) return
      const value = draft.value.trim()
      if (value === '') return
      // The id is generated HERE, before sealing, because the AEAD binds the sealed name
      // to it — a server-generated id would produce a name nobody can ever decrypt.
      const id = crypto.randomUUID()
      const supabase = supabaseBrowser()
      const { error: rpcError } =
        draft.kind === 'contact'
          ? await supabase.rpc('upsert_contact', {
              p_contact_id: id,
              p_workspace_id: workspaceId,
              p_fields: await sealFields(store, 'contact', id, [['name', value]]),
            })
          : await supabase.rpc('upsert_contact_group', {
              p_group_id: id,
              p_workspace_id: workspaceId,
              p_fields: await sealFields(store, 'contact_group', id, [['label', value]]),
            })
      if (rpcError !== null) throw rpcError
      setDraft(null)
    })

  const removeGroup = (groupId: string) =>
    run(async () => {
      const { error: rpcError } = await supabaseBrowser().rpc('delete_contact_group', {
        p_group_id: groupId,
      })
      if (rpcError !== null) throw rpcError
      setConfirmingGroup(null)
    })

  const addRowFor = (kind: 'contact' | 'group') =>
    draft?.kind === kind ? (
      <div className={styles.addRow}>
        <input
          className={styles.addInput}
          value={draft.value}
          maxLength={120}
          autoFocus
          disabled={busy}
          aria-label={kind === 'contact' ? 'Contact name' : 'Group name'}
          placeholder={kind === 'contact' ? 'Name' : 'Group name'}
          onChange={(event) => setDraft({ kind, value: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void add()
            if (event.key === 'Escape') setDraft(null)
          }}
        />
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setDraft(null)}>
          Cancel
        </Button>
        <Button size="sm" busy={busy} disabled={draft.value.trim() === ''} onClick={() => void add()}>
          Add
        </Button>
      </div>
    ) : (
      <div className={styles.addRow}>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !canWrite || !unlocked}
          title={
            canWrite && !unlocked
              ? 'Unlock your calendar first. Names are encrypted.'
              : undefined
          }
          onClick={() => setDraft({ kind, value: '' })}
        >
          {kind === 'contact' ? 'Add contact' : 'Add group'}
        </Button>
      </div>
    )

  return (
    <>
      <InlineError>{error}</InlineError>

      <section className={styles.band}>
        <header className={styles.panelHead}>
          <h2 className={styles.panelTitle}>Contacts</h2>
          <span className={styles.panelCount}>{registerCount(contacts.length)}</span>
        </header>

        {contacts.length === 0 ? (
          <p className={styles.empty}>
            {fixtureMode
              ? 'Demo data has no contacts of its own. Sign in to add people.'
              : 'No people yet. Add someone below, then decide what they see.'}
          </p>
        ) : (
          <ul className={styles.list}>
            {contacts.map((contact) => {
              const name = contactNames[contact.id]
              const level = decisionToLevel(
                workspaceDecisionFor(contact, workspaceId, workspaceRules, groupsByContact, now),
              )
              return (
                <li key={contact.id}>
                  <Link className={styles.personRow} href={{ pathname: `/people/${contact.id}` }}>
                    {/* A monogram, not an avatar: there is no photo to show and never will
                        be, but a row of names with nothing at the left edge is a list of
                        text. The letter comes from the DECRYPTED name, so before unlock it
                        is a neutral dot rather than the "C" of "Contact 4f2a…", which
                        would be a letter the server chose dressed as one the user did.
                        A DOT and not a dash: em dashes are banned in user-facing text here
                        and pinned by a DOM assertion, which is what caught this. */}
                    <span className={styles.monogram} aria-hidden="true">
                      {name === undefined ? '·' : name.trim().slice(0, 1).toUpperCase()}
                    </span>
                    <span className={styles.personText}>
                      <span className={styles.personName}>
                        {name ?? `Contact ${contact.id.slice(0, 8)}…`}
                      </span>
                      {/* The id the server files this person under — all it can ever read. */}
                      <span className={styles.personId}>{contact.id.slice(0, 8)}</span>
                    </span>
                    {/* What they get today, on the register itself. The whole point of the
                        book is who sees what, and the list used to make you open a file to
                        find out — so the one fact worth scanning for was the one fact it
                        withheld. Engine-derived, never restated (rule 3). */}
                    <PrivacyChip level={level} />
                    <span className={styles.personAction} aria-hidden="true">
                      ›
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}

        {addRowFor('contact')}
      </section>

      <section className={styles.band}>
        <header className={styles.panelHead}>
          <h2 className={styles.panelTitle}>Groups</h2>
          <span className={styles.panelCount}>{registerCount(groups.length)}</span>
        </header>

        {groups.length === 0 ? (
          <p className={styles.empty}>
            No groups yet. A group lets one rule cover several people at once.
          </p>
        ) : (
          <ul className={styles.list}>
            {/* Groups have no file of their own: a group's view is what its members get,
                and each member's file shows it. Membership is decided on the files too. */}
            {groups.map((group) => (
              <li key={group.id} className={styles.groupRow}>
                <span className={styles.monogram} data-group aria-hidden="true">
                  {groupNames[group.id] === undefined
                    ? '·'
                    : groupNames[group.id]!.trim().slice(0, 1).toUpperCase()}
                </span>
                <span className={styles.personText}>
                  <span className={styles.personName}>
                    {groupNames[group.id] ?? `Group ${group.id.slice(0, 8)}…`}
                  </span>
                  <span className={styles.personId}>{group.id.slice(0, 8)}</span>
                </span>
                <PrivacyChip
                  level={decisionToLevel(
                    workspaceDecisionFor(group, workspaceId, workspaceRules, groupsByContact, now),
                  )}
                />
                {confirmingGroup === group.id ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => setConfirmingGroup(null)}
                    >
                      Keep
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      busy={busy}
                      disabled={!canWrite}
                      onClick={() => void removeGroup(group.id)}
                    >
                      Remove
                    </Button>
                    <p className={styles.rowNote} role="alert">
                      Also removes any visibility rules for this group. Its members stay.
                    </p>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setConfirmingGroup(group.id)}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {addRowFor('group')}
      </section>

      {fixtureMode && (
        <p className={styles.demoNote}>Demo data. Sign in to manage people.</p>
      )}
    </>
  )
}
