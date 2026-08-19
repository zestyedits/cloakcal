'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { LEGACY_SETTINGS_HASHES } from '@/lib/settings-sections'

/**
 * `/settings#security` still has to land on the security page.
 *
 * A HASH NEVER REACHES THE SERVER. It is not in the request line, so this cannot be a
 * middleware rule, a `redirects()` entry in next.config, or anything on the route — and
 * somebody will eventually try, because every other redirect in this app is one of those.
 * The consequence worth stating up front: the hub renders, then this forwards. That flash is
 * unavoidable rather than a bug, and it is the price of the seven anchors staying alive.
 *
 * Links inside this repo do NOT come through here. `/account` and the Cloak sheet point at
 * the real routes directly; this is for bookmarks, for the browser's own history, and for
 * anything already sent out in an email.
 */
export function LegacyHashForward() {
  const router = useRouter()

  useEffect(() => {
    const forward = () => {
      // Read in the effect, not in render: there is no `location` during SSR, and the
      // hash is deliberately absent from the payload the server produced.
      const id = window.location.hash.slice(1)
      if (id === '') return
      const target = LEGACY_SETTINGS_HASHES[id]
      /*
       * A hash we do not recognise leaves the reader exactly where they are. Guessing a
       * destination for an arbitrary fragment is how an open redirect gets written, and a
       * hub is a perfectly good place to have landed.
       */
      if (target === undefined) return
      /*
       * REPLACE, not push. Push leaves `/settings#security` in the history, so Back returns
       * to the hub, this effect runs again and forwards again — a trap the reader cannot
       * escape with the control built for escaping it. Replacing also clears the fragment.
       */
      router.replace(target)
    }
    forward()
    // The Back button can restore a fragment without remounting this component.
    window.addEventListener('hashchange', forward)
    return () => window.removeEventListener('hashchange', forward)
  }, [router])

  return null
}
