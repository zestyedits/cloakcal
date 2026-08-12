'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { signOut } from '@/lib/cloak-session'
import { Button } from './ui/button'

/**
 * The door out — which somehow did not exist until a user pointed at its absence.
 *
 * `signOut` forgets the stored session keys BEFORE ending the Supabase session, in that
 * order deliberately: a stored key with no session is the worse leftover (it survives on
 * the device; a stale cookie expires). This button is just that function with a place to
 * live — once in the calendar sidebar, once in settings' Security card.
 */
export function SignOutButton({ className }: { className?: string | undefined }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  return (
    <Button
      variant="ghost"
      size="sm"
      className={className}
      busy={busy}
      onClick={() => {
        setBusy(true)
        void signOut()
          .catch(() => undefined)
          .then(() => {
            // Replace, not push: Back should not resurrect a signed-out session's page.
            router.replace('/sign-in')
            router.refresh()
          })
      }}
    >
      {busy ? 'Signing out' : 'Sign out'}
    </Button>
  )
}
