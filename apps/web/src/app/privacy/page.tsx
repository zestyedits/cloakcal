import { LegalScreen } from '@/components/legal-screen'
import { PRIVACY } from '@/lib/legal'

export const metadata = {
  title: 'Privacy · CloakCal',
  description:
    'What CloakCal stores, what it cannot read, and what you can do about it. CloakCal is not zero-knowledge and says so.',
}

/**
 * Reachable WITHOUT a session, which is the entire point.
 *
 * `/privacy` is in PUBLIC_PATHS and pinned by `middleware-paths.server.test.ts`. A legal page
 * behind the auth guard is a legal page nobody can read, and this repo has shipped that exact
 * class of bug twice: `/auth/callback` (confirmation links died before any JavaScript ran) and
 * the generated `/opengraph-image` route (every unfurl bot got a redirect to sign-in). Both
 * were invisible in dev and under Playwright, because both run with the dev-unlock flag that
 * returns before the redirect.
 *
 * No `force-dynamic` needed here and none added: the CSP nonce made every route dynamic
 * already, and this page reads no session, no cookies and no searchParams.
 */
export default function PrivacyPage() {
  return <LegalScreen document={PRIVACY} />
}
