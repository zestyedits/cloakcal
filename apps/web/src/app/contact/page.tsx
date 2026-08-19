import { ContactScreen } from '@/components/contact-screen'

export const metadata = {
  title: 'Contact · CloakCal',
  description:
    'How to reach CloakCal, who reads it, and the one thing writing to us cannot fix. No form, and the reason why.',
}

/**
 * Reachable WITHOUT a session, which is the entire point of building it.
 *
 * `CONTACT_PATH` is in PUBLIC_PATHS and pinned by `middleware-paths.server.test.ts`. The people
 * most likely to want this page are the ones who cannot sign in: a stranger deciding whether to
 * trust the product, somebody locked out, an app store reviewer, a regulator. Behind the auth
 * guard it would 307 to /sign-in and be useless to every one of them, and this repo has now
 * shipped that exact class of bug three times — `/auth/callback`, `/opengraph-image` and the
 * billing webhook — each time invisible in dev and under Playwright, because both run with the
 * dev-unlock flag that returns before the redirect.
 *
 * NO `force-dynamic`, and that is checked rather than assumed: this page reads no session, no
 * cookies and no searchParams, so it has nothing to be trapped by. The CSP nonce already opts
 * every route out of static generation anyway. Same reasoning as `/privacy`, stated there.
 */
export default function ContactPage() {
  return <ContactScreen />
}
