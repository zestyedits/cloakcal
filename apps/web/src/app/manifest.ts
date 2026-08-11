import type { MetadataRoute } from 'next'

/**
 * The web app manifest.
 *
 * The README has claimed "a PWA shell" since M1. There was no manifest and no icon set, so
 * the claim was false and nothing installed. This makes it true.
 *
 * Statically generated — it reads no cookies and calls no Supabase client, so it does not
 * touch the prerender trap that `/account` hit. Any future metadata route that DOES read a
 * session must say `export const dynamic = 'force-dynamic'`.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'CloakCal',
    short_name: 'CloakCal',
    // Deliberately the honest claim. CloakCal is NOT zero-knowledge: the server stores
    // times, durations and recurrence in the clear so booking and reminders can work, and
    // encrypts only the content. "Other people cannot see this" is true; "we cannot see
    // anything" is not, and this string is the sort of place that lie gets told by accident.
    description:
      'A privacy-first calendar. Event content is encrypted in your browser, and you choose ' +
      'how much of it each person sees.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#0b0d14',
    theme_color: '#0b0d14',
    categories: ['productivity', 'utilities'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // A separate asset, and `maskable` on its own rather than 'any maskable'. The mark is
      // shrunk inside the 80% safe circle here, which looks under-sized when a launcher does
      // NOT crop — so this one must never be chosen for the uncropped case. The spec ignores
      // an icon whose purposes it does not recognise, which is why the plain pair above has
      // to exist too rather than being replaced by this.
      {
        src: '/icons/icon-512-maskable.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  }
}
