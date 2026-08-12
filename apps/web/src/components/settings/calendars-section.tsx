'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabaseBrowser } from '@/lib/supabase/client'
import { rpcErrorMessage } from '@/lib/rpc-error'
import { sealFields } from '@/lib/cloaked-fields'
import type { SettingsCalendar } from '@/server/settings'
import { useCloakStore } from '../cloak-provider'
import { CloakedText } from '../cloaked-text'
import { Button } from '../ui/button'
import { Icon } from '../ui/icons'
import { InlineError } from '../ui/inline-error'
import styles from './settings.module.css'

const COLORS = ['indigo', 'teal', 'violet', 'rose', 'slate'] as const

/**
 * Calendars: rename and recolour, and the privacy model made visible in the split between
 * them. RECOLOUR STAYS LIVE WHILE LOCKED — the colour is Tier A, renders on busy-only
 * views, and needs no crypto. RENAME DISABLES WHILE LOCKED — the name is ciphertext, and
 * sealing a replacement needs the key. One row, two rules, both honest.
 */
export function CalendarsSection({
  fixtureMode,
  calendars,
}: {
  fixtureMode: boolean
  calendars: readonly SettingsCalendar[]
}) {
  const router = useRouter()
  const store = useCloakStore()
  const unlocked = store?.isUnlocked ?? false
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)

  const recolor = async (id: string, color: string) => {
    setBusyId(id)
    setError(null)
    try {
      const { error: rpcError } = await supabaseBrowser().rpc('update_calendar', {
        p_calendar_id: id,
        p_color_token: color,
      })
      if (rpcError !== null) throw rpcError
      router.refresh()
    } catch (caught) {
      setError(rpcErrorMessage(caught))
    } finally {
      setBusyId(null)
    }
  }

  const rename = async () => {
    if (renaming === null || store === null || renaming.value.trim() === '') return
    setBusyId(renaming.id)
    setError(null)
    try {
      const fields = await sealFields(store, 'calendar', renaming.id, [
        ['display_name', renaming.value.trim()],
      ])
      const { error: rpcError } = await supabaseBrowser().rpc('update_calendar', {
        p_calendar_id: renaming.id,
        p_fields: fields,
      })
      if (rpcError !== null) throw rpcError
      setRenaming(null)
      router.refresh()
    } catch (caught) {
      setError(rpcErrorMessage(caught))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section id="calendars" className={styles.section} aria-labelledby="calendars-title">
      <h2 id="calendars-title" className={styles.sectionTitle}>
        Calendars
      </h2>
      <p className={styles.sectionLede}>
        Names are encrypted — renaming needs your calendar unlocked. Colours are not: they
        show on busy-only views, so they were never secret.
      </p>

      <InlineError>{error}</InlineError>

      {calendars.length === 0 && (
        <p className={styles.lockedNote}>
          {fixtureMode ? 'Demo data — sign in to manage calendars.' : 'No calendars yet.'}
        </p>
      )}

      {calendars.map((calendar) => (
        <div key={calendar.id} className={styles.row}>
          {renaming?.id === calendar.id ? (
            <>
              <input
                className={styles.input}
                style={{ flex: 1 }}
                value={renaming.value}
                maxLength={120}
                autoFocus
                disabled={busyId === calendar.id}
                aria-label="New calendar name"
                onChange={(event) => setRenaming({ id: calendar.id, value: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void rename()
                  if (event.key === 'Escape') setRenaming(null)
                }}
              />
              <Button variant="outline" size="sm" onClick={() => setRenaming(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                busy={busyId === calendar.id}
                disabled={renaming.value.trim() === ''}
                onClick={() => void rename()}
              >
                Save
              </Button>
            </>
          ) : (
            <>
              <span className={styles.rowLabel}>
                <CloakedText
                  subjectType="calendar"
                  subjectId={calendar.id}
                  fieldName="display_name"
                  placeholder="Calendar"
                />
              </span>

              <div className={styles.swatches} role="group" aria-label="Calendar colour">
                {COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={styles.swatch}
                    data-color={color}
                    aria-pressed={calendar.colorToken === color}
                    aria-label={`Colour ${color}`}
                    disabled={busyId === calendar.id}
                    onClick={() => {
                      if (calendar.colorToken !== color) void recolor(calendar.id, color)
                    }}
                  >
                    <span className={styles.swatchInk}>
                      {calendar.colorToken === color && <Icon name="check" size={12} />}
                    </span>
                  </button>
                ))}
              </div>

              <Button
                variant="ghost"
                size="sm"
                disabled={!unlocked}
                title={unlocked ? undefined : 'Unlock your calendar to rename — names are encrypted'}
                onClick={() => setRenaming({ id: calendar.id, value: '' })}
              >
                Rename
              </Button>
            </>
          )}
        </div>
      ))}
    </section>
  )
}
