'use client'

import { createBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The browser Supabase client.
 *
 * This is the only client that may sit alongside key material, because it is the only one
 * running where key material is allowed to exist. Everything it writes to Tier B columns
 * has already been through CloakStore.seal(); everything it reads from them is ciphertext
 * until the store opens it.
 *
 * The publishable key is public by design — it identifies the project, it does not
 * authorise anything. Row Level Security is what authorises, and RLS is enforced in
 * Postgres regardless of what the client sends.
 */

let cached: SupabaseClient | null = null

export function supabaseBrowser(): SupabaseClient {
  if (cached !== null) return cached

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY

  if (url === undefined || key === undefined) {
    // Failing loudly beats a client that silently 401s every request and looks like an
    // auth bug for an afternoon.
    throw new Error(
      'Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and ' +
        'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in apps/web/.env.local (see .env.example).',
    )
  }

  /*
   * PASSKEY SIGN-IN IS OPT-IN AND STILL BETA, so the flag is here rather than assumed.
   * Supabase's `signInWithPasskey` and the `auth.passkey` namespace do not exist on the
   * client without it, and the failure without the flag is a missing method rather than a
   * refused request — which reads like a version problem and is not one. See ADR 0011.
   *
   * It changes nothing for any other caller: the flag adds methods, and a project with
   * passkeys switched off answers them with `passkey_disabled` rather than misbehaving.
   */
  cached = createBrowserClient(url, key, {
    auth: { experimental: { passkey: true } },
  })
  return cached
}
