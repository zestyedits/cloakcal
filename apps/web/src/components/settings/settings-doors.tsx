import Link from 'next/link'
import { visibleDoors, type SettingsDoorId, type SettingsSummary } from '@/lib/settings-sections'
import styles from './settings-hub.module.css'

/**
 * The four doors, drawn twice: as the hub itself, and as a quiet sibling list at the foot of
 * every settings sub-page.
 *
 * SERVER COMPONENTS, both of them, and that is the point of the whole restructure. What this
 * replaced was `SettingsNav`, a rail that measured an absolutely-positioned marker against
 * `[aria-current]`, re-measured on resize, on a ResizeObserver and on `document.fonts.ready`,
 * and tracked which of seven anchored sections was on screen. It has shipped two defects
 * nothing else could see — a numbered index at 3.46:1 in the light theme, and `min-width: 0`
 * on the flex child instead of the grid item, which left the rail illegible at 390px on four
 * pages while axe, the 44px sweep and `never scrolls sideways` all passed. Both are properties
 * of having a measured, positioned rail at all, so a four-item version reproduces both. These
 * are links in a grid. There is nothing here to measure.
 */

/**
 * The link's accessible name is the LABEL ALONE, via aria-labelledby.
 *
 * Without it the name is the whole card — label, description and summary run together — and
 * `getByRole('link', { name: 'Privacy' })` then matches this door AND the "Privacy policy"
 * link in the footer, because that matcher is a case-insensitive SUBSTRING. CLAUDE.md records
 * the same trap costing four negative assertions their meaning. The description and the
 * current-state line stay reachable through aria-describedby, so nothing is hidden; they are
 * simply not part of the name.
 */
export function SettingsDoors({
  summaries,
  fixtureMode,
  billingEnabled,
}: {
  /** Null when there are no account facts yet: signed in, no workspace row. */
  summaries: SettingsSummary | null
  fixtureMode: boolean
  billingEnabled: boolean
}) {
  return (
    <div className={styles.doors}>
      {visibleDoors(billingEnabled).map((door) => (
        <Link
          key={door.id}
          href={door.href}
          className={styles.door}
          aria-labelledby={`door-${door.id}-label`}
          aria-describedby={`door-${door.id}-about door-${door.id}-state`}
        >
          <h2 id={`door-${door.id}-label`} className={styles.doorLabel}>
            {door.label}
          </h2>
          <span id={`door-${door.id}-about`} className={styles.doorAbout}>
            {door.description}
          </span>
          <span id={`door-${door.id}-state`} className={styles.doorState}>
            {summaryFor(door.id, door.pending, summaries, fixtureMode)}
          </span>
          <Chevron />
        </Link>
      ))}
    </div>
  )
}

/**
 * EVERY line the demo shows is "Demo", and that is a rule rather than a shortcut.
 *
 * The Plan card already reasoned this way and was alone in it: it printed "Demo" rather than
 * "Free" because a plan is an ACCOUNT fact and the fixture has no account. So are contacts,
 * calendars, default rules and passkeys. A fixture that answers "02 calendars" is answering a
 * question about an account that does not exist, which is the same error the old readout band
 * made four times at display size.
 */
function summaryFor(
  id: SettingsDoorId,
  pending: string,
  summaries: SettingsSummary | null,
  fixtureMode: boolean,
): string {
  if (fixtureMode) return 'Demo'
  return summaries === null ? pending : summaries[id]
}

/**
 * The other doors, from a sub-page. Plain links, no current-state lines: this is lateral
 * movement, not a second copy of the hub.
 *
 * The page's OWN door is filtered out. A nav row pointing at the page you are reading is the
 * shape the rail had, where six of seven links went somewhere and one did nothing.
 */
export function SettingsSiblings({
  current,
  billingEnabled,
}: {
  current: SettingsDoorId
  billingEnabled: boolean
}) {
  /*
   * THE CURRENT PAGE IS IN THE LIST, AND THAT IS THE WHOLE POINT OF THE COMPONENT.
   *
   * This filtered itself out, which made the one thing on the page whose job is "where am I"
   * the one thing that would not say. What rendered was a row of somewhere-elses, identical on
   * every sub-page except for which item was missing -- a difference nobody reads as position.
   *
   * With the current door marked it becomes a MAP: four items, one of them you, in the same
   * place on every page. That is what stops the sub-pages blurring together, and it is cheaper
   * than any amount of per-page decoration.
   *
   * A span rather than a self-link, because a link to the page you are on is a control that
   * does nothing; `aria-current="page"` is what carries the state to anyone not looking at the
   * ink.
   */
  const doors = visibleDoors(billingEnabled)
  return (
    <nav className={styles.siblings} aria-label="Settings pages">
      {doors.map((door) =>
        door.id === current ? (
          <span key={door.id} className={styles.siblingCurrent} aria-current="page">
            {door.label}
          </span>
        ) : (
          <Link key={door.id} href={door.href} className={styles.sibling}>
            {door.label}
          </Link>
        ),
      )}
    </nav>
  )
}

/* A drawn mark, not the literal "›" character: a glyph's size, weight and optical centre are
   whatever the font hands you, and the display face here is not the one drawing it. */
function Chevron() {
  return (
    <svg
      className={styles.doorChevron}
      viewBox="0 0 12 12"
      width="12"
      height="12"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M4.5 2.5 L8 6 L4.5 9.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
