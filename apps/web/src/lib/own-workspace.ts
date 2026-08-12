'use client'

import { supabaseBrowser } from '@/lib/supabase/client'

/**
 * The signed-in user's own workspace id, resolved client-side.
 *
 * Resolved HERE rather than passed down from the server page, so the redacted payload
 * never has to carry a workspace id it would then be shipping to every audience. RLS
 * restricts the query to the caller's own rows; the oldest active workspace is the
 * personal one bootstrapWorkspace() created. Null means no workspace yet (or no
 * session), which callers surface as their own "not set up" state.
 */
export async function resolveOwnWorkspace(): Promise<string | null> {
  const { data } = await supabaseBrowser()
    .from('workspaces')
    .select('id')
    .eq('lifecycle', 'active')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle<{ id: string }>()
  return data?.id ?? null
}
