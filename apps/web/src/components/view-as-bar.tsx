'use client'

import { useRouter, useSearchParams } from 'next/navigation'
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
  audiences: ReadonlyArray<{ id: string; label: string }>
  current: string
  withheldCount: number
}) {
  const router = useRouter()
  const params = useSearchParams()

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
          <option key={audience.id} value={audience.id}>
            {audience.label}
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
