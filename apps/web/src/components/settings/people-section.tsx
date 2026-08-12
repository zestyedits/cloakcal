'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabaseBrowser } from '@/lib/supabase/client'
import { rpcErrorMessage } from '@/lib/rpc-error'
import { sealFields } from '@/lib/cloaked-fields'
import type { AudienceOption } from '@/lib/audiences'
import { useCloakStore } from '../cloak-provider'
import { useCloakedLabels } from '../use-cloaked-labels'
import { Button } from '../ui/button'
import { InlineError } from '../ui/inline-error'
import styles from './settings.module.css'

/**
 * Contacts and groups — the first UI over 0016/0017/0020, and ADR 0004 made visible.
 *
 * Names and labels are ciphertext, so: adding and renaming need the calendar UNLOCKED
 * (sealing needs the key) and disable honestly when it is not; deleting needs no crypto
 * and stays live, with the truncated id standing in for a name the server cannot read.
 * Pre-unlock the list shows `Contact 4f2a…` — the same honest fallback the View As picker
 * uses, because that is genuinely all the server knows.
 *
 * Membership lives with each group as a checkbox list; one RPC per toggle, the house
 * "one RPC per user action" rule at its smallest.
 */
export function PeopleSection({
  workspaceId,
  fixtureMode,
  audiences,
  membersByGroup,
}: {
  workspaceId: string | null
  fixtureMode: boolean
  audiences: readonly AudienceOption[]
  membersByGroup: Readonly<Record<string, readonly string[]>>
}) {
  const router = useRouter()
  const store = useCloakStore()
  const unlocked = store?.isUnlocked ?? false
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<{ kind: 'contact' | 'group'; value: string } | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [openGroup, setOpenGroup] = useState<string | null>(null)

  const contacts = audiences.filter((a) => a.kind === 'individual')
  const groups = audiences.filter((a) => a.kind === 'group')

  const contactNames = useCloakedLabels('contact', contacts.map((c) => c.id), 'name')
  const groupNames = useCloakedLabels('contact_group', groups.map((g) => g.id), 'label')

  const nameOf = (option: AudienceOption): string => {
    const name = option.kind === 'group' ? groupNames[option.id] : contactNames[option.id]
    if (name !== undefined && name !== '') return name
    return `${option.kind === 'group' ? 'Group' : 'Contact'} ${option.id.slice(0, 8)}`
  }

  const run = async (action: () => Promise<void>) => {
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

  const remove = (option: AudienceOption) =>
    run(async () => {
      const supabase = supabaseBrowser()
      const { error: rpcError } =
        option.kind === 'group'
          ? await supabase.rpc('delete_contact_group', { p_group_id: option.id })
          : await supabase.rpc('delete_contact', { p_contact_id: option.id })
      if (rpcError !== null) throw rpcError
      setConfirming(null)
    })

  const toggleMember = (groupId: string, contactId: string, isMember: boolean) =>
    run(async () => {
      const supabase = supabaseBrowser()
      const { error: rpcError } = isMember
        ? await supabase.rpc('remove_group_member', {
            p_group_id: groupId,
            p_contact_id: contactId,
          })
        : await supabase.rpc('add_group_member', { p_group_id: groupId, p_contact_id: contactId })
      if (rpcError !== null) throw rpcError
    })

  const rowFor = (option: AudienceOption) => (
    <div key={option.id} className={styles.row}>
      <span className={styles.rowLabel}>{nameOf(option)}</span>

      {confirming === option.id ? (
        <>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirming(null)}>
            Keep
          </Button>
          <Button variant="danger" size="sm" busy={busy} onClick={() => void remove(option)}>
            Remove
          </Button>
          <p className={styles.rowNote} role="alert">
            {option.kind === 'group'
              ? 'Also removes any visibility rules for this group. Its members stay.'
              : 'Also removes any visibility rules for this person.'}
          </p>
        </>
      ) : (
        <>
          {option.kind === 'group' && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              aria-expanded={openGroup === option.id}
              onClick={() => setOpenGroup(openGroup === option.id ? null : option.id)}
            >
              Members
            </Button>
          )}
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(option.id)}>
            Remove
          </Button>
        </>
      )}

      {option.kind === 'group' && openGroup === option.id && confirming !== option.id && (
        <div style={{ width: '100%' }}>
          {contacts.length === 0 && (
            <p className={styles.rowNote}>Add a contact first. A group is made of them.</p>
          )}
          {contacts.map((contact) => {
            const isMember = (membersByGroup[option.id] ?? []).includes(contact.id)
            return (
              <label key={contact.id} className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={isMember}
                  disabled={busy}
                  onChange={() => void toggleMember(option.id, contact.id, isMember)}
                />
                {nameOf(contact)}
              </label>
            )
          })}
        </div>
      )}
    </div>
  )

  return (
    <>
      <p className={styles.sectionLede}>
        Contacts are who your visibility rules point at. Their names are encrypted. The
        server sees only the ids below the names.
      </p>

      <InlineError>{error}</InlineError>

      {workspaceId === null ? (
        <p className={styles.lockedNote}>
          {fixtureMode ? 'Demo data. Sign in to manage people.' : 'Available once your calendar is set up.'}
        </p>
      ) : (
        <>
          {contacts.length === 0 && groups.length === 0 && (
            <p className={styles.rowNote}>
              No contacts yet. Add someone to control what they can see.
            </p>
          )}

          {contacts.map(rowFor)}
          {groups.map(rowFor)}

          {draft === null ? (
            <div className={styles.controls}>
              <Button
                variant="outline"
                disabled={!unlocked}
                title={unlocked ? undefined : 'Unlock your calendar first. Names are encrypted.'}
                onClick={() => setDraft({ kind: 'contact', value: '' })}
              >
                Add contact
              </Button>
              <Button
                variant="outline"
                disabled={!unlocked}
                title={unlocked ? undefined : 'Unlock your calendar first. Labels are encrypted.'}
                onClick={() => setDraft({ kind: 'group', value: '' })}
              >
                Add group
              </Button>
            </div>
          ) : (
            <div className={styles.row}>
              <input
                className={styles.input}
                style={{ flex: 1 }}
                value={draft.value}
                maxLength={120}
                autoFocus
                disabled={busy}
                aria-label={draft.kind === 'contact' ? 'Contact name' : 'Group name'}
                placeholder={draft.kind === 'contact' ? 'Name' : 'Group name'}
                onChange={(event) => setDraft({ ...draft, value: event.target.value })}
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
          )}
        </>
      )}
    </>
  )
}
