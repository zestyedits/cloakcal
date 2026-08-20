/*
 * THE SETTINGS GLYPH, in its own module because it now has TWO consumers: the calendar
 * header and the route loading fallback that has to look like it. It lived inside
 * calendar-screen.tsx while only one thing drew it; a second copy pasted into the fallback
 * is exactly how the fallback's lockup and theme toggle drifted from the real header in the
 * first place.
 *
 * SLIDERS, NOT A GEAR, AND THAT IS A CORRECTION RATHER THAN A PREFERENCE.
 *
 * The first draft drew the conventional cog: a small circle with eight radiating spokes. At
 * 18px that is a SUN — and it rendered directly beside the theme toggle, which is a sun. Two
 * near-identical glyphs, side by side, one of which changes the theme and one of which opens
 * Settings. A screenshot caught it; nothing else would have, because both have correct
 * accessible names and axe measures names rather than resemblance.
 *
 * Three sliders read as "controls" at any size and share no silhouette with anything else in
 * this header. Drawn rather than imported: an icon package for one shape is a licence and a
 * bundle for a dozen paths nobody uses.
 *
 * `aria-hidden` and `focusable="false"` because the link around it carries the name;
 * `theme-toggle.tsx` sets both for the same reason.
 */
export function SettingsMark() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <path d="M3 6h4M11 6h6M3 10h10M17 10h0M3 14h2M9 14h8" />
        <circle cx="9" cy="6" r="1.7" />
        <circle cx="15" cy="10" r="1.7" />
        <circle cx="7" cy="14" r="1.7" />
      </g>
    </svg>
  )
}
