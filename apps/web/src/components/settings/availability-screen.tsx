'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabaseBrowser } from '@/lib/supabase/client'
import { rpcErrorMessage } from '@/lib/rpc-error'
import type { AvailabilityWeek, AvailabilityWindow } from '@/server/availability'
import { PageMasthead, PageShell } from '../page-shell'
import { SettingsSiblings } from './settings-doors'
import { Button } from '../ui/button'
import { InlineError } from '../ui/inline-error'
import styles from './settings.module.css'
import local from './availability.module.css'

/**
 * /settings/availability — the hours you are open, per weekday.
 *
 * ITS OWN ROUTE rather than a band on /settings, for the reason Security was extracted:
 * seven days of multi-window rows is a page, not a row inside a one-at-a-time accordion.
 *
 * WHAT IT DOES TODAY, said plainly on the page itself: the calendar shades the hours outside
 * these windows, and that is all. It is the first piece of booking, and the temptation is to
 * describe it as though booking exists — this project already deleted a "Coming soon" card
 * for wearing the same weight as cards that work. So the copy names the one thing it does
 * and names booking as not built, rather than implying a client can act on any of it.
 *
 * WALL CLOCK, NOT INSTANTS. Every number here is minutes past local midnight in the
 * workspace timezone, and stays so across a DST shift. Nothing here builds a Date.
 */

const DAYS = [
  { index: 1, label: 'Monday' },
  { index: 2, label: 'Tuesday' },
  { index: 3, label: 'Wednesday' },
  { index: 4, label: 'Thursday' },
  { index: 5, label: 'Friday' },
  { index: 6, label: 'Saturday' },
  { index: 0, label: 'Sunday' },
] as const

/** Every half hour, as `<option>`s. 48 of them is a native select's comfort zone. */
const CHOICES = Array.from({ length: 48 }, (_, i) => i * 30)

const pad = (n: number) => String(n).padStart(2, '0')
/** 24-hour in the CONTROL, because a select of "1:30 PM" is slower to scan than 13:30. */
const optionLabel = (minute: number) => `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`

type Draft = Record<number, AvailabilityWindow[]>

const toDraft = (week: AvailabilityWeek): Draft => {
  const draft: Draft = {}
  for (const { index } of DAYS) draft[index] = [...(week[index] ?? [])]
  return draft
}

export function AvailabilityScreen({
  demo,
  workspaceId,
  timezone,
  week,
  billingEnabled,
}: {
  /** The dev fixture, said out loud rather than inferred from an empty id (demo-sentinel). */
  demo: boolean
  workspaceId: string | null
  timezone: string
  week: AvailabilityWeek
  /** Only so the sibling links agree with the hub about whether Billing is a door. */
  billingEnabled: boolean
}) {
  const router = useRouter()
  const [draft, setDraft] = useState<Draft>(() => toDraft(week))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  /*
   * EDITING IS ALWAYS LIVE; only SAVING is gated.
   *
   * The draft is local state, so changing a select in the demo costs nothing and persists
   * nothing — and it is the difference between a page you can try and a page of grey boxes,
   * which is the complaint that got the demo its own preferences in the first place. The
   * honesty is carried by the note above and by Save being visibly unavailable, not by
   * making the whole form dead.
   */
  const canSave = !demo && workspaceId !== null

  const edit = (next: Draft) => {
    setDraft(next)
    setSaved(false)
    setError(null)
  }

  const setWindow = (day: number, index: number, patch: Partial<AvailabilityWindow>) => {
    const windows = [...(draft[day] ?? [])]
    const current = windows[index]
    if (current === undefined) return
    windows[index] = { ...current, ...patch }
    edit({ ...draft, [day]: windows })
  }

  const addWindow = (day: number) => {
    const windows = [...(draft[day] ?? [])]
    const last = windows[windows.length - 1]
    // A new window starts after the last one ends, so adding one never creates an overlap
    // the server would reject. Clamped so the last hour of the day cannot produce a
    // zero-length window.
    const start = last === undefined ? 540 : Math.min(last.endMinute + 30, 1380)
    windows.push({ startMinute: start, endMinute: Math.min(start + 60, 1440) })
    edit({ ...draft, [day]: windows })
  }

  const removeWindow = (day: number, index: number) => {
    const windows = [...(draft[day] ?? [])]
    windows.splice(index, 1)
    edit({ ...draft, [day]: windows })
  }

  const save = async () => {
    if (!canSave || workspaceId === null) return
    setBusy(true)
    setError(null)
    try {
      const windows = DAYS.flatMap(({ index }) =>
        (draft[index] ?? []).map((w) => ({
          weekday: index,
          start_minute: w.startMinute,
          end_minute: w.endMinute,
        })),
      )
      const { error: rpcError } = await supabaseBrowser().rpc('set_availability', {
        p_workspace_id: workspaceId,
        p_windows: windows,
      })
      if (rpcError !== null) throw rpcError
      setSaved(true)
      router.refresh()
    } catch (caught) {
      setError(rpcErrorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <PageShell back={{ href: '/settings', label: 'Settings' }} measure="narrow">
      <PageMasthead
        title="Availability"
        lede="The hours you are open, and what the calendar shades outside them."
      />
      <main id="main" className={styles.panel}>
        <h2 className={styles.panelTitle}>The hours you are open</h2>
        <p className={styles.sectionLede}>
          Your calendar shades the hours outside these windows, so a week at a glance shows
          when you are actually working. Times are local to {timezone.replaceAll('_', ' ')},
          and they stay put across a daylight saving change.
        </p>

        {/*
          The honest boundary. Availability is the first piece of booking and nothing else
          reads it yet, so the page says so instead of letting a reader assume a client can
          already pick a slot.
        */}
        <p className={local.scope}>
          Nothing books itself yet. Booking pages are not built, so today this changes how
          your own calendar is drawn and nothing more.
        </p>

        <InlineError>{error}</InlineError>

        {demo && (
          <p className={styles.lockedNote}>
            Demo. Sign in to set your own hours. The week below is an example.
          </p>
        )}

        <ul className={local.days}>
          {DAYS.map(({ index, label }) => {
            const windows = draft[index] ?? []
            return (
              <li key={index} className={local.day}>
                <div className={local.dayHead}>
                  <h3 className={local.dayName}>{label}</h3>
                  <span className={local.dayState}>
                    {windows.length === 0 ? 'Unavailable' : null}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => addWindow(index)}
                  >
                    Add hours
                  </Button>
                </div>

                {windows.map((window, position) => (
                  <div key={position} className={local.window}>
                    <label className={local.field}>
                      <span className={styles.fieldLabel}>From</span>
                      <select
                        className={styles.select}
                        value={window.startMinute}
                        onChange={(event) =>
                          setWindow(index, position, {
                            startMinute: Number(event.target.value),
                          })
                        }
                      >
                        {CHOICES.map((minute) => (
                          <option key={minute} value={minute}>
                            {optionLabel(minute)}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className={local.field}>
                      <span className={styles.fieldLabel}>To</span>
                      <select
                        className={styles.select}
                        value={window.endMinute}
                        onChange={(event) =>
                          setWindow(index, position, { endMinute: Number(event.target.value) })
                        }
                      >
                        {/* Ends run to 24:00 so a window can reach midnight; starts cannot,
                            which the ordering check in the RPC already implies. */}
                        {[...CHOICES.slice(1), 1440].map((minute) => (
                          <option key={minute} value={minute}>
                            {minute === 1440 ? '24:00' : optionLabel(minute)}
                          </option>
                        ))}
                      </select>
                    </label>

                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove ${label} hours ${position + 1}`}
                      onClick={() => removeWindow(index, position)}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
              </li>
            )
          })}
        </ul>

        <div className={local.actions}>
          <Button busy={busy} disabled={!canSave} onClick={() => void save()}>
            Save hours
          </Button>
          {saved && <span className={local.saved}>Saved.</span>}
        </div>
      </main>

      <SettingsSiblings current="calendar" billingEnabled={billingEnabled} />
    </PageShell>
  )
}
