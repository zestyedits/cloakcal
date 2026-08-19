'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabaseBrowser } from '@/lib/supabase/client'
import { rpcErrorMessage } from '@/lib/rpc-error'
import type { DeletedEvent } from '@/lib/saved-event'
import { Button } from './ui/button'
import { InlineError } from './ui/inline-error'

/**
 * Undo, collecting a reversibility the schema paid for in 0008 and never spent.
 *
 * `trash_cloaked_event` has always moved a row to `lifecycle = 'trashed'` and deliberately
 * LEFT ITS CIPHERTEXT ALONE — its own header says "deleting them here would make the trash
 * one-way, which is not what a trash is". `cancel_occurrence` likewise writes a removable
 * exception row. Both were reversible in the database and irreversible in the product.
 *
 * TWO DIFFERENT UNDOS, because two different things were deleted. An event is a ROW, so it
 * comes back with `restore_cloaked_event`. An occurrence is a SUBTRACTION recorded against a
 * recurrence rule, so it comes back by removing that record. Sending one where the other
 * belongs would either resurrect a whole series or quietly do nothing, which is why
 * `occurrenceLocal` is the discriminator rather than a flag someone could forget to set.
 *
 * NOT TIMED, and that is the point of the whole design. A five-second undo is a wall-clock
 * budget on somebody's attention — the same mistake as budgeting a test's observation window
 * against a clock, which this repo has already paid for once. It stays until it is used,
 * dismissed, or replaced by the next result.
 */
export function UndoDelete({
  info,
  onUndone,
}: {
  info: DeletedEvent
  onUndone: () => void
}) {
  const router = useRouter()
  const button = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /**
   * Focus moves ONLY after a keyboard delete. The confirmation lived inside a <dialog> that
   * has just unmounted, so a keyboard user is otherwise stranded on <body> with the one
   * control that matters somewhere below them. A pointer user is not stranded, and moving
   * their focus for them would be the app taking something away rather than offering it.
   */
  useEffect(() => {
    if (info.keyboard) button.current?.focus()
  }, [info])

  const undo = async () => {
    setBusy(true)
    setError(null)
    try {
      const { error: rpcError } =
        info.occurrenceLocal === null
          ? await supabaseBrowser().rpc('restore_cloaked_event', {
              p_event_id: info.eventId,
              p_deleted_from_version: info.deletedFromVersion,
            })
          : await supabaseBrowser().rpc('uncancel_occurrence', {
              // No version: a series is not frozen the way a trashed row is, so a guard
              // here could only invent conflicts out of edits to other occurrences. The
              // long comment above the function in 0031 is the argument.
              p_series_id: info.eventId,
              p_occurrence_local: info.occurrenceLocal,
            })
      if (rpcError !== null) throw rpcError

      onUndone()
      router.refresh()
    } catch (caught) {
      /*
       * CODE DEPLOYS ON PUSH AND MIGRATIONS ARE APPLIED BY HAND, so the two always disagree
       * for a window and this is the first thing a user would meet inside it. PostgREST
       * answers an unknown function with PGRST202, which `rpcErrorMessage` would surface as
       * its raw "Could not find the function public.restore_cloaked_event(...) in the schema
       * cache" — accurate, useless, and alarming next to a deletion.
       *
       * The important half of the sentence is the second one: nothing was lost. The event is
       * still in the trash exactly as it was, so this is a missing button rather than a
       * missing event.
       */
      const code = (caught as { code?: string } | null)?.code
      setError(
        code === 'PGRST202'
          ? 'Undo is not available on this deployment yet. The event is still in your trash, under Settings, Security and data.'
          : rpcErrorMessage(caught),
      )
      setBusy(false)
    }
  }

  return (
    <>
      <Button ref={button} variant="outline" size="sm" busy={busy} onClick={() => void undo()}>
        {busy ? 'Restoring' : 'Undo'}
      </Button>
      <InlineError>{error}</InlineError>
    </>
  )
}
