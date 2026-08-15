import type { Route } from 'next'
import type { CiphertextField } from '@/server/events'

/**
 * The audience shape, in a module with no server dependencies.
 *
 * This lived in `server/visibility.ts` until the build refused it: that file carries
 * `import 'server-only'`, and `view-as-bar.tsx` is a client component that needs the type and
 * the id helper. The guard was right — a client bundle must not be able to reach
 * `supabaseServer` — so the pure half moves here rather than the marker being removed.
 *
 * Nothing in this file does I/O or touches a key. It is a shape and a string function.
 */

export interface AudienceOption {
  readonly id: string
  readonly kind: 'owner' | 'individual' | 'group' | 'public'
  /**
   * Sealed display name, opened in the browser. Absent for owner and public, which are not
   * rows and have no name to encrypt.
   */
  readonly nameField?: CiphertextField
}

/**
 * The `?as=` value for an audience.
 *
 * Namespaced for contacts and groups because both are uuids and the engine treats them very
 * differently — a bare id in the URL would make "as this person" and "as anyone in this
 * group" indistinguishable, and the two produce different answers.
 */
export function audienceIdOf(option: AudienceOption): string {
  if (option.kind === 'owner' || option.kind === 'public') return option.kind
  return `${option.kind === 'group' ? 'group' : 'contact'}:${option.id}`
}

/**
 * The URL for previewing as an audience, keeping every other query param.
 *
 * One implementation because there are now two doors into preview — the sidebar's picker
 * and the Cloak sheet's per-person rows — and the last time this screen had two ways to do
 * one thing, they were two live copies of the same control fighting over the same state.
 * Owner DELETES the param rather than setting `as=owner`, so the plain calendar URL stays
 * the plain calendar URL.
 *
 * The `as Route` is the one typedRoutes escape hatch, in one place. Next types `push` as
 * `RouteImpl<…>` and cannot check a string built at runtime; inlined template literals
 * happen to satisfy it, which is why this compiled everywhere until the logic moved behind
 * a function. Worth knowing that `pnpm typecheck` does NOT see this — typedRoutes only
 * exists during `next build`, so a green typecheck is not evidence a computed href
 * compiles. Same family as WeekLink, which exists for exactly this reason.
 */
export function audienceHref(currentQuery: string, audienceId: string): Route {
  const next = new URLSearchParams(currentQuery)
  if (audienceId === 'owner') next.delete('as')
  else next.set('as', audienceId)
  return (next.size > 0 ? `/?${next.toString()}` : '/') as Route
}
