import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'CloakCal',
  description: 'Not everything is for everyone.',
}

export const viewport: Viewport = {
  themeColor: '#0b0d14',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

/**
 * Root layout — a Server Component, and deliberately incapable of decryption.
 * It never imports the crypto or cloak-store packages; the static rule enforces that.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <body>
        <a className="skip-link" href="#main">
          Skip to calendar
        </a>
        {children}
      </body>
    </html>
  )
}
