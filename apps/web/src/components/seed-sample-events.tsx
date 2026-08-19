'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Temporal } from '@js-temporal/polyfill'
import { useCloakStore } from './cloak-provider'
import { sealFields } from '@/lib/cloaked-fields'
import { armFirstRun } from '@/lib/first-run'
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
 *
 * EIGHT WRITES, CONCURRENT, AND PARTIAL SUCCESS IS A REAL OUTCOME. These used to run in a
 * sequential `for` loop behind one static "Encrypting and adding" — eight round trips with
 * no progress, and a failure on the fifth left four events on the calendar, an error that
 * did not say how far it got, and a button resting mid-sentence. The eight share no row and
 * each RPC is its own transaction, so there is nothing to serialise: `Promise.allSettled`
 * runs them together and, crucially, CANNOT REJECT — so the partial case is a value to
 * render rather than an exception to swallow.
 *
 * What that buys is honesty. If six land, the copy says six landed, the six stay, and the
 * retry re-attempts EXACTLY the two that did not — results map back to the attempted specs
 * by index, which is why `remaining` holds specs rather than a count. The one thing this
 * must never do is claim completion or rest in "Adding…".
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
  { day: 2, time: '14:00', minutes: 45, title: 'Legal call, custody', location: 'Conference Rm B', notes: 'Bring the March filings.' },
  { day: 3, time: '09:30', minutes: 60, title: 'Project review', notes: 'Q3 scope cuts.' },
  { day: 3, time: '17:30', minutes: 60, title: 'Gym', busy: 'free' },
  { day: 4, time: '10:00', minutes: 30, title: 'Client meeting, Bramblewick', location: 'Video' },
  { day: 5, time: '15:00', minutes: 90, title: 'Deep work: proposal draft' },
  { day: 6, time: '11:00', minutes: 60, title: 'Farmers market', busy: 'free' },
]

export function SeedSampleEvents({ from, timezone }: { from: string; timezone: string }) {
  const store = useCloakStore()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Settled attempts in the run currently in flight, for the progress label. */
  const [settled, setSettled] = useState(0)
  /** How many of SEEDS have actually landed, across every attempt. */
  const [added, setAdded] = useState(0)
  /**
   * The seeds still owed, or null before anything has been tried. A retry reads from HERE
   * rather than from SEEDS, which is what makes "try the remaining two" re-attempt the two
   * that failed instead of writing six duplicates.
   */
  const [remaining, setRemaining] = useState<readonly Seed[] | null>(null)

  const unlocked = store !== null && store.isUnlocked
  const attempt = remaining ?? SEEDS
  const partial = remaining !== null && remaining.length > 0

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
    setSettled(0)

    let workspaceId: string
    let calendarId: string
    try {
      const supabase = supabaseBrowser()

      // Same resolution as the compose sheet: the caller's own oldest workspace and its
      // default calendar, under RLS. Sequential and AHEAD of the fan-out — every write
      // below needs both ids, so there is nothing here to overlap.
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

      workspaceId = workspace.id
      calendarId = calendar.id
    } catch (caught) {
      // Nothing was attempted, so nothing is owed differently than before this click.
      setError(caught instanceof Error ? caught.message : String(caught))
      setBusy(false)
      return
    }

    const weekStart = Temporal.PlainDate.from(weekFirst)

    const write = async (spec: Seed) => {
      // Sealed against the event's own id BEFORE anything is written — the AEAD binds
      // ciphertext to the id, so it has to exist first. Same order as the compose sheet.
      const eventId = globalThis.crypto.randomUUID()
      const local = weekStart
        .add({ days: spec.day })
        .toPlainDateTime(Temporal.PlainTime.from(spec.time))
      const zoned = local.toZonedDateTime(timezone, { disambiguation: 'earlier' })
      const end = zoned.add({ minutes: spec.minutes })

      const content: Array<[string, string]> = [['title', spec.title]]
      if (spec.location !== undefined) content.push(['location', spec.location])
      if (spec.notes !== undefined) content.push(['notes', spec.notes])

      const { error: rpcError } = await supabaseBrowser().rpc('create_cloaked_event', {
        p_event_id: eventId,
        p_workspace_id: workspaceId,
        p_calendar_id: calendarId,
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

    // allSettled, never all: one failure must not discard the seven that worked. It cannot
    // reject, so every branch below reads a value instead of catching one.
    const results = await Promise.allSettled(
      attempt.map((spec) => write(spec).finally(() => setSettled((n) => n + 1))),
    )

    const failed = attempt.filter((_, index) => results[index]!.status === 'rejected')
    const landed = attempt.length - failed.length

    setAdded((n) => n + landed)
    setRemaining(failed)
    setBusy(false)

    // The first failure's own words. Every seed takes an identical path, so a second
    // distinct reason is unlikely and eight copies of one message would be noise.
    const firstFailure = results.find((result) => result.status === 'rejected')
    if (firstFailure !== undefined && firstFailure.status === 'rejected') {
      const reason: unknown = firstFailure.reason
      setError(reason instanceof Error ? reason.message : String(reason))
    }

    // Conditional only on something having landed: a partial run is exactly the case where
    // SEEING the six is what makes a sentence about six mean anything.
    if (landed > 0) {
      // Seeding IS a first save, so it arms the first-contact invitation. A calendar full
      // of sample events and no way to notice the privacy model is the exact dead end the
      // prompt exists for.
      armFirstRun()
      router.refresh()
    }
  }

  return (
    <div className={styles.root}>
      <InlineError>{error}</InlineError>
      <Button
        variant="outline"
        busy={busy}
        disabled={!unlocked}
        title={unlocked ? undefined : 'Unlock your calendar first. Sample events are encrypted like real ones.'}
        onClick={() => void seed()}
      >
        {busy
          ? `Encrypting and adding ${Math.min(settled + 1, attempt.length)} of ${attempt.length}`
          : partial
            ? `Try the remaining ${remaining.length}`
            : 'Add sample events'}
      </Button>
      {/* Never a claim of completion, and never a state left mid-sentence: after a partial
          run this says exactly what landed and exactly what is still owed. */}
      <p className={styles.note}>
        {partial
          ? `Added ${added} of ${SEEDS.length}. ${remaining.length} could not be saved. The ones that landed are on your calendar and can stay.`
          : 'Eight ordinary events, encrypted on this device like real ones. Delete them any time.'}
      </p>
    </div>
  )
}
