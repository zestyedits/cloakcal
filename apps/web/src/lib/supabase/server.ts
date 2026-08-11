import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The server Supabase client.
 *
 * Runs as the signed-in user — never with a service-role key. That is deliberate and load
 * bearing: the service role bypasses RLS entirely, so a single careless query with it would
 * hand one user another user's rows, and no amount of application-level checking would
 * reliably prevent it. Reading as the user means Postgres enforces the workspace boundary
 * on every statement, and the policy tests in packages/db actually cover the production
 * path rather than an approximation of it.
 *
 * WHAT THIS CLIENT MAY TOUCH: Tier A metadata and Tier B *ciphertext*. It has no key and
 * cannot acquire one — @cloakcal/crypto and @cloakcal/cloak-store may not be imported from
 * any server module, which server-boundary.leak.test.ts enforces statically.
 *
 * NEVER CACHE ACROSS REQUESTS. The client carries the caller's session; a module-level
 * cache like the browser client's would serve one user's session to the next request.
 */

export async function supabaseServer(): Promise<SupabaseClient> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY

  if (url === undefined || key === undefined) {
    throw new Error(
      'Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and ' +
        'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (see apps/web/.env.example).',
    )
  }

  const store = await cookies()

  return createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) store.set(name, value, options)
        } catch {
          // Server Components cannot set cookies. Refresh happens in middleware instead,
          // so swallowing here is correct rather than lazy — see middleware.ts.
        }
      },
    },
  })
}
