'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabaseBrowser } from '@/lib/supabase/client'
import { rpcErrorMessage } from '@/lib/rpc-error'
import styles from './delete-event.module.css'

/**
 * Delete an event, or one occurrence of a repeating one.
 *
 * TRASH, NOT DESTROY. `trash_cloaked_event` moves the row to `lifecycle = 'trashed'` and
 * leaves the sealed fields in place. The event vanishes from the calendar because the read
 * path filters on `active`, but nothing is actually gone yet. The copy says "Delete" because
 * that is what the user means; the honest word for what happens is "trash", and a restore
 * view can be built on top of this without a migration.
 *
 * NOTHING TO ENCRYPT, AND THAT IS THE POINT. Unlike creating, deleting touches no content —
 * it sends ids and a version and gets back nothing. So this component never needs a key, and
 * works whether or not the calendar is unlocked. That is true of the per-occurrence path too:
 * the ciphertext belongs to the series and the surviving occurrences still need it.
 *
 * THE VERSION IS NOT OPTIONAL. It comes from the server render, so it is a snapshot of the
 * row as this page saw it. If anything changed it since, the RPC refuses and the user is
 * told to reload rather than being allowed to delete a thing they are no longer looking at.
 * Two tabs on one calendar is the ordinary case, not an exotic one.
 *
 * ---------------------------------------------------------------------------
 * TWO SCOPES, NOT THREE — AND WHY THE MISSING ONE IS MISSING
 * ---------------------------------------------------------------------------
 *
 * The edit sheet offers three: this occurrence, this and all following, the whole series.
 * Delete offers two. "This and all following" is not a subtraction, it is a TRUNCATION of the
 * recurrence rule, and a wrong UNTIL silently eats the occurrence the user was standing on.
 * `split-plan.ts` exists to prove a truncation is lossless before it is written, and the
 * delete path has no equivalent yet. Shipping the option without that proof would make the
 * one irreversible action the least verified one.
 *
 * Offering two honest choices beats offering three where the third is unchecked.
 */

type Scope = 'occurrence' | 'series'

/**
 * The consequence of each choice, said plainly. This is the sentence that stops somebody
 * deleting forty meetings when they meant one, so it states the surprising part — that the
 * whole series includes occurrences that have already happened — rather than implying it.
 */
const SCOPE_COPY: Record<Scope, { label: string; consequence: string }> = {
  occurrence: {
    label: 'Only this one',
    consequence: 'This occurrence is removed. The rest of the series stays.',
  },
  series: {
    label: 'The whole series',
    consequence: 'Every occurrence goes, including ones that have already happened.',
  },
}

export function DeleteEvent({
  eventId,
  version,
  recurring,
  occurrenceLocal,
  label,
}: {
  eventId: string
  version: number
  recurring: boolean
  /**
   * The ORIGINAL local wall time of the occurrence being looked at — never an instant, and
   * never re-derived here. ADR 0001 keys exceptions by local time so a DST shift cannot move
   * them, and `cancel_occurrence` rejects anything that is not exactly `YYYY-MM-DDTHH:MM:SS`.
   */
  occurrenceLocal: string
  /** Describes the event without naming it — the title is encrypted and stays that way. */
  label: string
}) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Defaults to the smaller blast radius. Someone who clicks Delete on a Tuesday and then
  // clicks Delete again almost never means every Tuesday.
  const [scope, setScope] = useState<Scope>('occurrence')

  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      const supabase = supabaseBrowser()
      const { error: rpcError } =
        recurring && scope === 'occurrence'
          ? await supabase.rpc('cancel_occurrence', {
              p_series_id: eventId,
              p_expected_version: version,
              p_occurrence_local: occurrenceLocal,
            })
          : await supabase.rpc('trash_cloaked_event', {
              p_event_id: eventId,
              p_expected_version: version,
            })
      if (rpcError !== null) throw rpcError

      setConfirming(false)
      router.refresh()
    } catch (caught) {
      // The RPC distinguishes its failure modes deliberately, so say which one happened
      // instead of collapsing them into "something went wrong". Matched on the slug the RPC
      // puts in `hint`, not on its message text — this used to regex the prose, which made
      // the wording of a `raise exception` into an interface nobody knew they were bound by.
      setError(rpcErrorMessage(caught))
      setBusy(false)
    }
  }

  if (!confirming) {
    return (
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setConfirming(true)}
        aria-label={`Delete ${label}`}
      >
        Delete
      </button>
    )
  }

  return (
    <div className={styles.confirm} role="group" aria-label={`Confirm deleting ${label}`}>
      {recurring ? (
        <fieldset className={styles.scope}>
          <legend className={styles.question}>Delete which?</legend>
          {(Object.keys(SCOPE_COPY) as Scope[]).map((option) => (
            <label key={option} className={styles.scopeRow}>
              <input
                type="radio"
                // Scoped to the event: several rows can be confirming at once, and a bare
                // "scope" would make every open confirmation share one radio group.
                name={`delete-scope-${eventId}-${occurrenceLocal}`}
                value={option}
                checked={scope === option}
                disabled={busy}
                onChange={() => setScope(option)}
              />
              {SCOPE_COPY[option].label}
            </label>
          ))}
          <p className={styles.note} aria-live="polite">
            {SCOPE_COPY[scope].consequence}
          </p>
        </fieldset>
      ) : (
        <p className={styles.question}>Delete this event?</p>
      )}

      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.cancel}
          disabled={busy}
          onClick={() => {
            setConfirming(false)
            setError(null)
            setScope('occurrence')
          }}
        >
          Keep
        </button>
        <button type="button" className={styles.destroy} disabled={busy} onClick={remove}>
          {busy ? 'Deleting' : 'Delete'}
        </button>
      </div>
    </div>
  )
}
