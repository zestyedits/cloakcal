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
