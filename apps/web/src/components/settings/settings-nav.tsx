import { SECTIONS } from '@/lib/settings-sections'
import styles from './settings.module.css'

/**
 * THE settings rail, shared by /settings and every page reached from it.
 *
 * WHY THE SUB-PAGES CARRY IT. Security and People used to drop the rail entirely, so
 * clicking into one read as leaving Settings rather than moving inside it — no sense of
 * where you were, and an 18rem change of measure on the way. Keeping the rail and swapping
 * only the panel beside it is what makes a submenu feel like part of its menu.
 *
 * NOT a client component and no state of its own: which item is current is a fact the
 * caller already knows. That is also what lets the loading fallbacks render the identical
 * markup from the identical source instead of hand-copying it, which is how the old
 * fallback drifted to a five-chip rail the real page no longer had.
 */
export function SettingsNav({
  current,
  /**
   * Where the links point. `hash` for /settings itself, where every section is on the page;
   * `settings` from a sub-page, where they have to navigate back first.
   */
  scope = 'hash',
}: {
  current: string | null
  scope?: 'hash' | 'settings'
}) {
  return (
    <nav className={styles.nav} aria-label="Settings sections">
      {SECTIONS.map((section) => (
        <a
          key={section.id}
          className={styles.navLink}
          href={scope === 'hash' ? `#${section.id}` : `/settings#${section.id}`}
          aria-current={section.id === current ? 'true' : undefined}
        >
          {section.label}
        </a>
      ))}
    </nav>
  )
}
