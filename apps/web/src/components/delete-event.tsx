'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabaseBrowser } from '@/lib/supabase/client'
import { rpcErrorMessage } from '@/lib/rpc-error'
import styles from './delete-event.module.css'

/**
 * Delete an event.
 *
 * TRASH, NOT DESTROY. `trash_cloaked_event` moves the row to `lifecycle = 'trashed'` and
 * leaves the sealed fields in place. The event vanishes from the calendar because the read
 * path filters on `active`, but nothing is actually gone yet. The copy says "Delete" because
 * that is what the user means; the honest word for what happens is "trash", and a restore
 * view can be built on top of this without a migration.
 *
 * NOTHING TO ENCRYPT, AND THAT IS THE POINT. Unlike creating, deleting touches no content —
 * it sends an id and a version and gets back nothing. So this component never needs a key,
 * and works whether or not the calendar is unlocked.
 *
 * THE VERSION IS NOT OPTIONAL. It comes from the server render, so it is a snapshot of the
 * row as this page saw it. If anything changed it since, the RPC refuses and the user is
 * told to reload rather than being allowed to delete a thing they are no longer looking at.
 * Two tabs on one calendar is the ordinary case, not an exotic one.
 *
 * WHOLE SERIES, FOR NOW. A recurring event is one row, so trashing it removes every
 * occurrence. Per-occurrence deletion needs the recurrence-exception path from
 * packages/db, which is not wired up yet — so the confirmation says plainly that all
 * occurrences will go rather than quietly doing more than the user expected.
 */

export function DeleteEvent({
  eventId,
  version,
  recurring,
  label,
}: {
  eventId: string
  version: number
  recurring: boolean
  /** Describes the event without naming it — the title is encrypted and stays that way. */
  label: string
}) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      const { error: rpcError } = await supabaseBrowser().rpc('trash_cloaked_event', {
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
      <p className={styles.question}>
        {recurring ? 'Delete every occurrence?' : 'Delete this event?'}
      </p>

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
