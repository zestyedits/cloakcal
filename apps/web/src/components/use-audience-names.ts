'use client'

import type { AudienceOption } from '@/lib/audiences'
import { useCloakedLabels } from './use-cloaked-labels'

/**
 * Turning a sealed audience into a label, in ONE place.
 *
 * There were two: `labelFor` in view-as-bar.tsx and `nameOf` in cloak-sheet.tsx, differing
 * only in that the sheet had no "Me" branch because it filtered the owner out first. Two
 * copies of the same fallback string is precisely how "Contact 4f2a…" would come to read
 * one way in the sidebar and another in the sheet.
 *
 * Before unlock — or for a contact whose name will not open — this returns a truncated id
 * rather than a name. That is not a degraded state to paper over. It is what the server
 * actually sees (ADR 0004: contact names are ciphertext), and showing it makes the boundary
 * legible instead of implying the names were available all along.
 */
export function useAudienceNames(
  audiences: readonly AudienceOption[],
): (option: AudienceOption) => string {
  const contactNames = useCloakedLabels(
    'contact',
    audiences.filter((a) => a.kind === 'individual').map((a) => a.id),
    'name',
  )
  const groupNames = useCloakedLabels(
    'contact_group',
    audiences.filter((a) => a.kind === 'group').map((a) => a.id),
    'label',
  )

  return (option: AudienceOption): string => {
    if (option.kind === 'owner') return 'Me'
    if (option.kind === 'public') return 'Anyone with the link'
    const name = option.kind === 'group' ? groupNames[option.id] : contactNames[option.id]
    if (name !== undefined && name !== '') {
      return option.kind === 'group' ? `Anyone in ${name}` : name
    }
    return `${option.kind === 'group' ? 'Group' : 'Contact'} ${option.id.slice(0, 8)}`
  }
}
