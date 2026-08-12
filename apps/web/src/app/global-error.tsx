'use client'

import './globals.css'

/**
 * The boundary behind the boundary: this replaces the ROOT LAYOUT when the layout itself
 * throws, so it must render its own <html> and <body> — including data-theme, because the
 * palettes are attribute-scoped and an unset attribute leaves every token undefined.
 *
 * The inline styles are not decoration: if the crash happened early enough, globals.css
 * may never have applied, and a fallback page that renders as unstyled black-on-white
 * soup fails at the one job it has. Dark hexes are hardcoded to match the dark tokens —
 * this screen does not attempt themes; it attempts legibility.
 *
 * No components, no Button, no logo import — every dependency is another thing that can
 * be broken in the state that got us here.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html lang="en" data-theme="dark">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'grid',
          placeItems: 'center',
          padding: '1rem',
          background: '#0b0d14',
          color: '#f5f6fa',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        }}
      >
        <main
          style={{
            maxWidth: '26rem',
            padding: '1.5rem',
            border: '1px solid rgba(245, 246, 250, 0.14)',
            borderRadius: 20,
            background: '#161a25',
          }}
        >
          <h1 style={{ margin: 0, fontSize: '1.5rem' }}>CloakCal stopped</h1>
          <p style={{ color: 'rgba(245, 246, 250, 0.72)', lineHeight: 1.65 }}>
            Something failed before the page could even frame itself. Nothing was shown to
            anyone. Reload to try again.
          </p>
          {error.digest !== undefined && (
            <p style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.75rem', color: 'rgba(245, 246, 250, 0.5)' }}>
              Support code: {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={reset}
            style={{
              minHeight: 44,
              padding: '0 1rem',
              border: 0,
              borderRadius: 8,
              background: '#6152e6',
              color: '#f5f6fa',
              font: 'inherit',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  )
}
