'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { audienceIdOf, type AudienceOption } from '@/lib/audiences'
import { useCloakedLabels } from './use-cloaked-labels'
import styles from './calendar-screen.module.css'

/**
 * View As — spec §4 calls this a trust feature, so it renders through the same server
 * redaction a real recipient gets. Switching audience refetches from the server rather
 * than filtering on the client, because client-side filtering would prove nothing.
 */
export function ViewAsBar({
  audiences,
  current,
  withheldCount,
}: {
  audiences: readonly AudienceOption[]
  current: string
  withheldCount: number
}) {
  const router = useRouter()
  const params = useSearchParams()

  // Contact and group names are Cloaked (ADR 0004), so the server sends ids and ciphertext
  // and the labels are opened here. An `<option>` holds text rather than elements, which is
  // why this needs a hook returning strings instead of the usual `<CloakedText>`.
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

  /**
   * Before unlock — or for a contact whose name will not open — the picker shows a truncated
   * id rather than a name.
   *
   * That is not a degraded state to hide. It is what the server sees, and showing it makes
   * the boundary legible instead of implying the names were available all along.
   */
  const labelFor = (option: AudienceOption): string => {
    if (option.kind === 'owner') return 'Me'
    if (option.kind === 'public') return 'Anyone with the link'
    const name =
      option.kind === 'group' ? groupNames[option.id] : contactNames[option.id]
    if (name !== undefined && name !== '') {
      return option.kind === 'group' ? `Anyone in ${name}` : name
    }
    return `${option.kind === 'group' ? 'Group' : 'Contact'} ${option.id.slice(0, 8)}`
  }

  const select = (id: string) => {
    const next = new URLSearchParams(params.toString())
    if (id === 'owner') next.delete('as')
    else next.set('as', id)
    router.push(next.size > 0 ? `/?${next.toString()}` : '/')
  }

  return (
    <div className={styles.viewAs}>
      <label className={styles.viewAsLabel} htmlFor="view-as">
        Viewing as
      </label>
      <select
        id="view-as"
        className={styles.viewAsSelect}
        value={current}
        onChange={(event) => select(event.target.value)}
      >
        {audiences.map((audience) => (
          <option key={audience.id} value={audienceIdOf(audience)}>
            {labelFor(audience)}
          </option>
        ))}
      </select>

      {current !== 'owner' && (
        <p className={styles.viewAsNote}>
          {withheldCount === 0
            ? 'They can see every event below.'
            : `${withheldCount} ${withheldCount === 1 ? 'event is' : 'events are'} hidden from them entirely.`}
        </p>
      )}
    </div>
  )
}
