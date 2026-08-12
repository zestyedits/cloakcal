'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Temporal } from '@js-temporal/polyfill'
import { useCloakStore } from './cloak-provider'
import { sealFields } from '@/lib/cloaked-fields'
import { supabaseBrowser } from '@/lib/supabase/client'
import { Button } from './ui/button'
import { InlineError } from './ui/inline-error'
import styles from './seed-sample-events.module.css'

/**
 * "Add sample events" — the empty calendar's way in, and the ONLY honest way to seed an
 * account with readable test data.
 *
 * It cannot be done from the server, and that is the product working: titles are sealed
 * with keys derived from the account's root key, which exists only in this browser after
 * unlock. A server-side seeder could write rows, but their content would be either
 * plaintext (forbidden — no Tier B column exists to even put it in) or ciphertext nobody
 * could ever open. So the samples are sealed HERE, through the same sealFields → RPC path
 * a real event takes, and they are real events — editable, deletable, redactable.
 *
 * Renders only for the owner, on an empty week, with a workspace behind it. Disabled
 * until unlocked, because sealing needs the key.
 */

interface Seed {
  readonly day: number
  readonly time: string
  readonly minutes: number
  readonly title: string
  readonly location?: string
  readonly notes?: string
  readonly busy?: 'busy' | 'free'
  readonly rrule?: string
}

/** Offsets are days from the visible week's first day, whatever weekday that is. */
const SEEDS: readonly Seed[] = [
  { day: 1, time: '09:00', minutes: 30, title: 'Team standup', location: 'Zoom', rrule: 'FREQ=WEEKLY' },
  { day: 1, time: '12:00', minutes: 60, title: 'Lunch with Alex', location: 'Blue Door Café', busy: 'free' },
  { day: 2, time: '14:00', minutes: 45, title: 'Legal call — custody', location: 'Conference Rm B', notes: 'Bring the March filings.' },
  { day: 3, time: '09:30', minutes: 60, title: 'Project review', notes: 'Q3 scope cuts.' },
  { day: 3, time: '17:30', minutes: 60, title: 'Gym', busy: 'free' },
  { day: 4, time: '10:00', minutes: 30, title: 'Client meeting — Bramblewick', location: 'Video' },
  { day: 5, time: '15:00', minutes: 90, title: 'Deep work — proposal draft' },
  { day: 6, time: '11:00', minutes: 60, title: 'Farmers market', busy: 'free' },
]

export function SeedSampleEvents({ from, timezone }: { from: string; timezone: string }) {
  const store = useCloakStore()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const unlocked = store !== null && store.isUnlocked

  // The visible week's first day as a wall date in the display zone — the same Intl
  // pattern the grids use. Everything else is PlainDate arithmetic from it.
  const weekFirst = useMemo(
    () =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(from)),
    [from, timezone],
  )

  const seed = async () => {
    if (store === null || !store.isUnlocked) return
    setBusy(true)
    setError(null)
    try {
      const supabase = supabaseBrowser()

      // Same resolution as the compose sheet: the caller's own oldest workspace and its
      // default calendar, under RLS.
      const { data: workspace } = await supabase
        .from('workspaces')
        .select('id')
        .eq('lifecycle', 'active')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle<{ id: string }>()
      if (workspace === null) throw new Error('No workspace found for this account yet.')

      const { data: calendar } = await supabase
        .from('calendars')
        .select('id')
        .eq('workspace_id', workspace.id)
        .eq('lifecycle', 'active')
        .order('is_default', { ascending: false })
        .limit(1)
        .maybeSingle<{ id: string }>()
      if (calendar === null) throw new Error('No calendar found for this account yet.')

      const first = Temporal.PlainDate.from(weekFirst)

      for (const spec of SEEDS) {
        // Sealed against the event's own id BEFORE anything is written — the AEAD binds
        // ciphertext to the id, so it has to exist first. Same order as the compose sheet.
        const eventId = globalThis.crypto.randomUUID()
        const local = first
          .add({ days: spec.day })
          .toPlainDateTime(Temporal.PlainTime.from(spec.time))
        const zoned = local.toZonedDateTime(timezone, { disambiguation: 'earlier' })
        const end = zoned.add({ minutes: spec.minutes })

        const content: Array<[string, string]> = [['title', spec.title]]
        if (spec.location !== undefined) content.push(['location', spec.location])
        if (spec.notes !== undefined) content.push(['notes', spec.notes])

        const { error: rpcError } = await supabase.rpc('create_cloaked_event', {
          p_event_id: eventId,
          p_workspace_id: workspace.id,
          p_calendar_id: calendar.id,
          p_timezone: timezone,
          p_start_utc: zoned.toInstant().toString(),
          p_end_utc: end.toInstant().toString(),
          // Local wall clock, as TEXT, per the house rule: a timezone-carrying string
          // parsed into `timestamp` silently drops its offset.
          p_dtstart_local: local.toString(),
          p_rrule: spec.rrule ?? null,
          p_busy: spec.busy ?? 'busy',
          p_fields: await sealFields(store, 'event', eventId, content),
        })
        if (rpcError !== null) throw rpcError
      }

      router.refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setBusy(false)
    }
  }

  return (
    <div className={styles.root}>
      <InlineError>{error}</InlineError>
      <Button
        variant="outline"
        busy={busy}
        disabled={!unlocked}
        title={unlocked ? undefined : 'Unlock your calendar first — sample events are encrypted like real ones'}
        onClick={() => void seed()}
      >
        {busy ? 'Encrypting and adding' : 'Add sample events'}
      </Button>
      <p className={styles.note}>
        Eight ordinary events, encrypted on this device like real ones. Delete them any
        time.
      </p>
    </div>
  )
}
