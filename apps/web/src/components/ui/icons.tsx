/**
 * The app's icon set: seven glyphs, inline, no network request and no icon font.
 *
 * The first four are the `PRIVACY_LEVELS` icons — every privacy state renders an icon AND
 * a label so colour is never the sole carrier of meaning (tokens.ts calls a component that
 * skips either one a defect). `eye-half` is an eye with its lower half absent rather than
 * dimmed, echoing the cloak mark, where the dates under the cloak are absent.
 *
 * Lives in apps/web rather than @cloakcal/ui deliberately: that package is tokens only,
 * React-free, and stays that way.
 *
 * `aria-hidden` by default — an icon next to a label is decoration. The rare standalone
 * icon gets its accessible name from the CONTROL (aria-label on the button), never from
 * the SVG.
 */

export type IconName = 'eye' | 'eye-half' | 'clock' | 'eye-off' | 'plus' | 'chevron' | 'check'

const STROKED: Record<IconName, ReadonlyArray<string>> = {
  eye: [
    'M1.5 8C3.4 4.7 5.6 3 8 3s4.6 1.7 6.5 5C12.6 11.3 10.4 13 8 13s-4.6-1.7-6.5-5Z',
    'M8 6.2A1.8 1.8 0 1 1 8 9.8 1.8 1.8 0 0 1 8 6.2Z',
  ],
  // The top lid and a hard horizon. Below the line there is nothing, not a fainter eye.
  'eye-half': ['M1.5 8C3.4 4.7 5.6 3 8 3s4.6 1.7 6.5 5', 'M1.5 8h13'],
  clock: ['M8 2a6 6 0 1 1 0 12A6 6 0 0 1 8 2Z', 'M8 4.8V8l2.3 1.5'],
  'eye-off': [
    'M1.5 8C3.4 4.7 5.6 3 8 3s4.6 1.7 6.5 5C12.6 11.3 10.4 13 8 13s-4.6-1.7-6.5-5Z',
    'M2.5 2.5l11 11',
  ],
  plus: ['M8 3v10', 'M3 8h10'],
  chevron: ['M6 3.5 10.5 8 6 12.5'],
  check: ['M3 8.5 6.5 12 13 4.5'],
}

export function Icon({
  name,
  size = 16,
  className,
}: {
  name: IconName
  /** Rendered size in px. The geometry is drawn on a 16px grid. */
  size?: number
  className?: string | undefined
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...(className === undefined ? {} : { className })}
    >
      {STROKED[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}
