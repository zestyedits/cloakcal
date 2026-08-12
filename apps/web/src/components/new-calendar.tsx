'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useCloakStore } from './cloak-provider'
import { EventSheet } from './event-sheet'
import { eventFieldStyles, Field } from './event-fields'
import { Icon } from './ui/icons'
import { sealFields } from '@/lib/cloaked-fields'
import { resolveOwnWorkspace } from '@/lib/own-workspace'
import { rpcErrorMessage } from '@/lib/rpc-error'
import { supabaseBrowser } from '@/lib/supabase/client'
import styles from './new-calendar.module.css'

/**
 * Create a calendar — the board's "+ Add Calendar" row, finally built (0021).
 *
 * Same order-of-operations as creating an event: the id is generated HERE so the name can
 * be sealed against it before anything is written (the AEAD binds ciphertext to the
 * subject id), then one RPC writes the calendar and its sealed name in one transaction.
 * The name never exists in plaintext outside this browser.
 *
 * DISABLED WHILE LOCKED, like every control that needs the key. The colour swatches are
 * inside the sheet rather than live-editing anything, so the whole form shares one gate.
 */

const COLORS = ['indigo', 'teal', 'violet', 'rose', 'slate'] as const

export function NewCalendarButton() {
  const store = useCloakStore()
  const [open, setOpen] = useState(false)
  const locked = store === null || !store.isUnlocked

  return (
    <>
      <button
        type="button"
        className={styles.addRow}
        disabled={locked}
        title={locked ? 'Unlock your calendar first. Calendar names are encrypted.' : undefined}
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true">+</span> Add calendar
      </button>
      {open && <NewCalendar onClose={() => setOpen(false)} />}
    </>
  )
}

export function NewCalendar({ onClose }: { onClose: () => void }) {
  const store = useCloakStore()
  const router = useRouter()
  const nameId = useId()

  const [name, setName] = useState('')
  const [color, setColor] = useState<(typeof COLORS)[number]>('indigo')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)

    if (store === null || !store.isUnlocked) {
      setError('Your calendar is locked. Unlock it before adding a calendar.')
      return
    }
    const trimmed = name.trim()
    if (trimmed === '') return

    setBusy(true)
    try {
      const workspaceId = await resolveOwnWorkspace()
      if (workspaceId === null) {
        setError('No workspace found for this account yet.')
        return
      }

      const calendarId = globalThis.crypto.randomUUID()
      const fields = await sealFields(store, 'calendar', calendarId, [
        ['display_name', trimmed],
      ])

      const { error: rpcError } = await supabaseBrowser().rpc('create_calendar', {
        p_calendar_id: calendarId,
        p_workspace_id: workspaceId,
        p_color_token: color,
        p_fields: fields,
      })
      if (rpcError !== null) throw rpcError

      onClose()
      router.refresh()
    } catch (caught) {
      setError(rpcErrorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <EventSheet
      title="New calendar"
      error={error}
      busy={busy}
      submitLabel={busy ? 'Encrypting and saving' : 'Create'}
      onSubmit={submit}
      onClose={onClose}
    >
      <Field label="Name" htmlFor={nameId}>
        <input
          id={nameId}
          className={eventFieldStyles.input}
          value={name}
          maxLength={120}
          autoFocus
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
        />
        <p className={styles.hint}>Encrypted on this device before it is saved.</p>
      </Field>

      <div className={styles.swatches} role="group" aria-label="Calendar colour">
        {COLORS.map((option) => (
          <button
            key={option}
            type="button"
            className={styles.swatch}
            data-color={option}
            aria-pressed={color === option}
            aria-label={`Colour ${option}`}
            disabled={busy}
            onClick={() => setColor(option)}
          >
            <span className={styles.swatchInk}>
              {color === option && <Icon name="check" size={12} />}
            </span>
          </button>
        ))}
      </div>
    </EventSheet>
  )
}
