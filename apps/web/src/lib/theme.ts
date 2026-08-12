/**
 * Light or dark, chosen by the user, remembered across visits.
 *
 * DARK IS THE DEFAULT and light is a first-class option — Keith's call, 2026-08-12, and it
 * overrides what `docs/calendar-design.md` originally recommended. The references draw the
 * calendar on white, which is why light had to become properly supported rather than a
 * theoretical second palette; the default is a product decision rather than a reading of the
 * board, and the board does not settle it.
 *
 * Both palettes are attribute-scoped in `tokens.css` — `:root[data-theme='dark']` and
 * `:root[data-theme='light']` — so the attribute is never optional. There is no bare fallback
 * theme; an unset attribute leaves the semantic tokens undefined and the page unreadable.
 * That is why the server renders `data-theme="dark"` rather than omitting it.
 */

export type Theme = 'dark' | 'light'

export const DEFAULT_THEME: Theme = 'dark'

/** Read by the pre-paint script below, so the name is duplicated there. Keep them in step. */
export const THEME_STORAGE_KEY = 'cloakcal-theme'

export const isTheme = (value: unknown): value is Theme => value === 'dark' || value === 'light'

export function readStoredTheme(): Theme {
  try {
    const stored = globalThis.localStorage?.getItem(THEME_STORAGE_KEY)
    return isTheme(stored) ? stored : DEFAULT_THEME
  } catch {
    // Storage can throw outright in a locked-down browser or a sandboxed frame. A theme is
    // not worth breaking a page over, so this falls back rather than propagating.
    return DEFAULT_THEME
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset['theme'] = theme
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // Same reasoning. The theme still applies for this session; it just will not persist.
  }
}

/**
 * Runs before first paint, inline in `<head>`.
 *
 * WITHOUT THIS THERE IS A FLASH. The server has no idea which theme this visitor chose —
 * `/` is dynamic but the preference lives in the browser, and reading it in an effect means
 * the page paints dark, hydrates, then snaps to light. On a calendar full of pastel event
 * blocks that is a full-screen white flash on every navigation, which is worse than not
 * offering the choice.
 *
 * It is deliberately tiny and synchronous: anything async, and paint wins the race. It is
 * also the reason this is a string rather than a module — it has to execute before any bundle
 * loads.
 *
 * `try/catch` because a page that throws here renders nothing at all.
 */
export const THEME_BOOTSTRAP = `try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`
